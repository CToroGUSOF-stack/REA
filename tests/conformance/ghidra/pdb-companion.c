/* Source-owned PE + PDB pair for verify:ghidra:pdb. The names below exist only
 * in the PDB; the linked image carries no symbol table, so Ghidra can only
 * report them by applying the caller-selected PDB. */
#ifndef REA_PDB_VARIANT
#define REA_PDB_VARIANT 3
#endif

__declspec(noinline) int rea_pdb_scale(int value, int offset) {
  return value * REA_PDB_VARIANT + offset;
}

int rea_pdb_entry(void) { return rea_pdb_scale(4, 5); }
