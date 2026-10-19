const concat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const pad4 = (bytes: Buffer): Buffer => {
  const pad = (4 - (bytes.length % 4)) % 4;
  return pad === 0 ? bytes : concat(bytes, Buffer.alloc(pad));
};

const chunk = (name: string, payload: Buffer): Buffer =>
  concat(Buffer.from(name, "latin1"), u32(payload.length), pad4(payload));

const atoms = (names: readonly string[], utf8 = true): Buffer => {
  const body = concat(
    u32(names.length),
    ...names.map((name) => {
      const encoded = Buffer.from(name, utf8 ? "utf8" : "latin1");
      return concat(Buffer.from([encoded.length]), encoded);
    }),
  );
  return chunk(utf8 ? "AtU8" : "Atom", body);
};

const table = (name: string, rows: readonly (readonly number[])[]): Buffer => {
  const payload = concat(
    u32(rows.length),
    ...rows.flatMap((row) => row.map(u32)),
  );
  return chunk(name, payload);
};

/** Hand-authored BEAM IFF with AtU8, Code, ExpT, ImpT and FunT chunks. */
export const erlangBeamFixture = (module = "beam_fixture"): Buffer => {
  const atomNames = [
    module,
    "module_info",
    "start",
    "erlang",
    "get_module_info",
  ];
  const codeHeader = concat(
    u32(16),
    u32(0),
    u32(169),
    u32(4),
    u32(2),
    Buffer.from("code"),
  );
  const chunks = concat(
    atoms(atomNames),
    chunk("Code", codeHeader),
    table("ExpT", [
      [3, 0, 2],
      [2, 0, 1],
      [2, 1, 3],
    ]),
    table("ImpT", [[4, 5, 1]]),
    table("FunT", [[3, 1, 4, 0, 0, 42]]),
  );
  const form = concat(Buffer.from("BEAM", "latin1"), chunks);
  return concat(Buffer.from("FOR1", "latin1"), u32(form.length), form);
};

/** BEAM form whose atom table exceeds a caller-selected atom budget. */
export const erlangBeamManyAtomsFixture = (count: number): Buffer => {
  const names = Array.from(
    { length: count },
    (_, index) => `a${String(index)}`,
  );
  const chunks = atoms(names);
  const form = concat(Buffer.from("BEAM", "latin1"), chunks);
  return concat(Buffer.from("FOR1", "latin1"), u32(form.length), form);
};
