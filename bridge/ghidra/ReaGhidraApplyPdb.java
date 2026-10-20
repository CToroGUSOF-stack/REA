import ghidra.app.plugin.core.analysis.PdbUniversalAnalyzer;
import ghidra.app.util.bin.format.pdb2.pdbreader.AbstractPdb;
import ghidra.app.util.bin.format.pdb2.pdbreader.PdbIdentifiers;
import ghidra.app.util.bin.format.pdb2.pdbreader.PdbParser;
import ghidra.app.util.bin.format.pdb2.pdbreader.PdbReaderOptions;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.app.util.pdb.PdbProgramAttributes;
import ghidra.program.model.listing.Program;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Hand a caller-selected PDB to Ghidra's PDB analyzer before auto-analysis,
 * only after proving it belongs to this Program.
 *
 * Arguments: the PDB path, its committed SHA-256, GUID and decimal age. The
 * script re-hashes the file, reads the PDB's own GUID and age with Ghidra's PDB
 * reader, and requires both to equal the committed values and the Program's
 * RSDS CodeView record. Any mismatch throws, which aborts processing before
 * analysis and the bridge. On success the outcome is stored as a program
 * property that the bridge reports during its handshake.
 */
public final class ReaGhidraApplyPdb extends HeadlessScript {
    static final String REPORT_OPTION = "REA PDB companion";
    private static final int HASH_CHUNK_BYTES = 4 * 1024 * 1024;

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 4) {
            throw new IllegalArgumentException(
                "REA PDB script requires the PDB path, SHA-256, GUID and age");
        }
        Path path = Path.of(args[0]);
        String committedSha256 = args[1].toLowerCase(Locale.ROOT);
        String committedGuid = normalizeGuid(args[2]);
        long committedAge = Long.parseLong(args[3]);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("REA PDB file is not a regular file: " + path);
        }

        String sha256 = sha256(path);
        if (!sha256.equals(committedSha256)) {
            throw new IllegalStateException("REA PDB file changed after the analysis profile was " +
                "committed: expected sha256 " + committedSha256 + ", observed " + sha256);
        }

        String pdbGuid;
        long pdbAge;
        try (AbstractPdb pdb = PdbParser.parse(path.toFile(), new PdbReaderOptions(), monitor)) {
            PdbIdentifiers identifiers = pdb.getIdentifiers();
            pdbGuid = normalizeGuid(String.valueOf(identifiers.getGuid()));
            pdbAge = Integer.toUnsignedLong(identifiers.getAge());
        }

        PdbProgramAttributes attributes = new PdbProgramAttributes(currentProgram);
        String programGuid = attributes.getPdbGuid() == null
            ? null : normalizeGuid(attributes.getPdbGuid());
        long programAge = attributes.getPdbAge() == null
            ? -1 : Long.parseLong(attributes.getPdbAge(), 16);
        if (programGuid == null) {
            throw new IllegalStateException(
                "REA PDB refused: the Program records no RSDS CodeView GUID to match against");
        }
        if (!pdbGuid.equals(committedGuid) || pdbAge != committedAge ||
            !programGuid.equals(committedGuid) || programAge != committedAge) {
            throw new IllegalStateException("REA PDB refused: PDB GUID " + pdbGuid + " age " +
                pdbAge + " does not match the Program CodeView GUID " + programGuid + " age " +
                programAge + " (committed GUID " + committedGuid + " age " + committedAge + ")");
        }

        File file = path.toFile();
        PdbUniversalAnalyzer.setPdbFileOption(currentProgram, file);
        String report = "{\"format\":\"rea-ghidra-pdb-v1\",\"sha256\":\"" + sha256 + "\"" +
            ",\"guid\":\"" + pdbGuid + "\",\"age\":" + pdbAge +
            ",\"program_guid\":\"" + programGuid + "\",\"program_age\":" + programAge + "}";
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_OPTION, report);
        println("REA PDB applied: " + path + " " + report);
    }

    /** Lowercase dashed 8-4-4-4-12 form; any other spelling is returned lowercased. */
    private static String normalizeGuid(String value) {
        String hex = value.replaceAll("[{}\\-]", "").toLowerCase(Locale.ROOT);
        if (!hex.matches("[0-9a-f]{32}")) return value.toLowerCase(Locale.ROOT);
        return hex.substring(0, 8) + "-" + hex.substring(8, 12) + "-" + hex.substring(12, 16) +
            "-" + hex.substring(16, 20) + "-" + hex.substring(20);
    }

    private String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[HASH_CHUNK_BYTES];
        try (InputStream input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                monitor.checkCancelled();
                digest.update(buffer, 0, read);
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
