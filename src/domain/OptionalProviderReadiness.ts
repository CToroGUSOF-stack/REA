/** Loading an optional native module does not establish target or device readiness. */
export type OptionalProviderReadiness = {
  readonly provider: string;
  readonly scope: "native-module";
} & (
  | { readonly status: "ready" }
  | {
      readonly status: "unavailable" | "unknown";
      readonly reason:
        | "dependency-absent"
        | "module-load-failed"
        | "probe-failed";
      readonly detail: string;
      readonly remediation: string;
      readonly recovery?: {
        readonly command: readonly string[];
        readonly workingDirectory: string;
      };
    }
);
