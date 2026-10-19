import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
} from "./PeCertificates.fixture.js";
import {
  DER_NODE_BUDGET,
  decodeOid,
  parseCertificate,
  PeCertificateDerFailure,
  readDer,
} from "./PeCertificateDer.js";
import { parsePeCertificates } from "./PeCertificateParser.js";

const defaults = inspectPeCertificatesInputSchema.parse({
  path: "/artifacts/app.exe",
});

const parse = (bytes: Buffer) =>
  parsePeCertificates(
    bytes,
    {
      path: defaults.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    defaults,
  );

it("reads PE32 and PE32+ PKCS#7 certificate tables", () => {
  for (const plus of [false, true]) {
    const bytes = peCertificateFixture(plus);
    const report = parse(bytes);
    expect(report.format).toBe(plus ? "pe32-plus" : "pe32");
    expect(report.table).not.toBeNull();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      revision: 0x0200,
      certificate_type: 2,
      certificate_type_name: "pkcs7",
    });
    expect(report.entries[0]?.pkcs7).toMatchObject({
      content_type_oid: "1.2.840.113549.1.7.2",
      content_type_name: "signedData",
      digest_algorithm_oids: ["2.16.840.1.101.3.4.2.1"],
    });
    const certificate = report.entries[0]?.pkcs7?.certificates[0];
    expect(certificate?.serial_hex).toBe("11223344");
    expect(certificate?.subject.text).toContain("commonName=REA Fixture");
    expect(certificate?.not_before).toBe("250101000000Z");
    expect(report.coverage).toEqual({
      status: "complete",
      examined_entries: 1,
      certificates: 1,
    });
  }
});

it("reports an absent security directory without claiming the image is unsigned", () => {
  const report = parse(peWithoutCertificateTableFixture());
  expect(report.table).toBeNull();
  expect(report.entries).toEqual([]);
  expect(report.limitations[0]).toMatch(
    /IMAGE_DIRECTORY_ENTRY_SECURITY is absent/u,
  );
});

it("fails truncated WIN_CERTIFICATE payloads without partial success", () => {
  const bytes = peCertificateFixture();
  const tableOffset = bytes.readUInt32LE(0x80 + 24 + 96 + 32);
  bytes.writeUInt32LE(4, tableOffset);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("fails PKCS#7 payloads that are not signedData", () => {
  const bytes = peCertificateFixture(false, Buffer.from("not-pkcs7"), 0x0002);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("keeps unknown certificate types as payload hashes without PKCS#7 projection", () => {
  const payload = pkcs7SignedDataFixture();
  const report = parse(peCertificateFixture(false, payload, 0x0001));
  expect(report.entries[0]).toMatchObject({
    certificate_type_name: "x509",
    pkcs7: null,
  });
  expect(report.entries[0]?.payload.sha256).toBe(
    createHash("sha256").update(payload).digest("hex"),
  );
});

const der = (tag: number, content: Buffer): Buffer => {
  const length = content.length;
  const header =
    length < 0x80
      ? Buffer.from([tag, length])
      : length <= 0xff
        ? Buffer.from([tag, 0x81, length])
        : length <= 0xffff
          ? Buffer.from([tag, 0x82, length >> 8, length & 0xff])
          : Buffer.from([
              tag,
              0x83,
              length >> 16,
              (length >> 8) & 0xff,
              length & 0xff,
            ]);
  return Buffer.concat([header, content]);
};
const derSeq = (...children: Buffer[]) => der(0x30, Buffer.concat(children));
const derSet = (...children: Buffer[]) => der(0x31, Buffer.concat(children));
const derInt = (value: number) => der(0x02, Buffer.from([value]));
const SIGNED_DATA_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
]);
const DATA_OID = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
]);
const SHA256_ALG = derSeq(
  Buffer.from([
    0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
  ]),
);
const contentInfo = (signedData: Buffer) =>
  derSeq(SIGNED_DATA_OID, der(0xa0, signedData));

it("fails signedData that omits encapContentInfo and signerInfos", () => {
  const truncated = contentInfo(derSeq(derInt(1), derSet()));
  expect(() => parse(peCertificateFixture(false, truncated))).toThrow(
    /encapContentInfo/u,
  );
});

it("fails a SignerInfo without its signature", () => {
  const signer = derSeq(
    derInt(1),
    derSeq(derSeq(), derInt(1)),
    SHA256_ALG,
    SHA256_ALG,
  );
  const payload = contentInfo(
    derSeq(derInt(1), derSet(SHA256_ALG), derSeq(DATA_OID), derSet(signer)),
  );
  expect(() => parse(peCertificateFixture(false, payload))).toThrow(
    /signature OCTET STRING/u,
  );
});

it("stops decoding a certificate payload at the DER node budget", () => {
  const values = Buffer.alloc(2 * (DER_NODE_BUDGET + 1));
  for (let at = 0; at < values.length; at += 2) values[at] = 0x05;
  const payload = contentInfo(derSeq(derInt(1), der(0x31, values)));
  expect(() => parse(peCertificateFixture(false, payload))).toThrow(
    /node budget/u,
  );
});

it("rejects headers whose section table does not fit SizeOfHeaders", () => {
  const bytes = peWithoutCertificateTableFixture();
  bytes.writeUInt16LE(0xffff, 0x86);
  bytes.writeUInt32LE(0, 0x98 + 60);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

it("decodes OBJECT IDENTIFIER arcs without truncation", () => {
  expect(decodeOid(Buffer.from([0x88, 0x37, 0x03]))).toBe("2.999.3");
  expect(decodeOid(Buffer.from([0x69, 0x90, 0x80, 0x80, 0x80, 0x00]))).toBe(
    "2.25.4294967296",
  );
  expect(decodeOid(Buffer.from([0x2a, 0x86, 0x48]))).toBe("1.2.840");
});

it("decodes UniversalString names as UTF-32BE", () => {
  const universal = (text: string) => {
    const content = Buffer.alloc(text.length * 4);
    [...text].forEach((character, index) =>
      content.writeUInt32BE(character.codePointAt(0) ?? 0, index * 4),
    );
    return der(0x1c, content);
  };
  const cn = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
  const name = derSeq(derSet(derSeq(cn, universal("REA"))));
  const tbs = derSeq(
    derInt(1),
    SHA256_ALG,
    name,
    derSeq(
      der(0x17, Buffer.from("250101000000Z")),
      der(0x17, Buffer.from("260101000000Z")),
    ),
    name,
  );
  const certificate = readDer(
    derSeq(tbs, SHA256_ALG, der(0x03, Buffer.from([0]))),
  );
  expect(parseCertificate(certificate).subject.text).toBe("commonName=REA");
  const odd = derSeq(derSet(derSeq(cn, der(0x1c, Buffer.from([0, 0, 0])))));
  const broken = readDer(
    derSeq(
      derSeq(
        derInt(1),
        SHA256_ALG,
        odd,
        derSeq(der(0x17, Buffer.from("x")), der(0x17, Buffer.from("x"))),
        odd,
      ),
      SHA256_ALG,
    ),
  );
  expect(() => parseCertificate(broken)).toThrow(PeCertificateDerFailure);
});
