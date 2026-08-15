type ReleaseReference = Readonly<{
  version: string;
  refName: string;
  ref: string;
}>;

/** Validates that publication is anchored to the package's exact version tag. */
export function validatePublishRelease(input: ReleaseReference): void {
  const version = expectVersion(input.version);
  const expectedTag = `v${version}`;
  if (
    input.refName !== expectedTag ||
    input.ref !== `refs/tags/${expectedTag}`
  ) {
    throw new Error(
      `Refusing to publish ${version}: expected refs/tags/${expectedTag}, received ${input.ref}`,
    );
  }
}

async function readPackageVersion(): Promise<string> {
  const parsed: unknown = JSON.parse(await Deno.readTextFile("deno.json"));
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error("deno.json must contain a string version");
  }
  return (parsed as { version: string }).version;
}

function expectVersion(value: string): string {
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
      .test(value)
  ) {
    throw new Error("deno.json version must be a semantic version");
  }
  return value;
}

if (import.meta.main) {
  const [refName, ref] = Deno.args;
  if (!refName || !ref || Deno.args.length !== 2) {
    throw new Error(
      "Usage: validate_publish_release.ts <git-ref-name> <full-git-ref>",
    );
  }
  validatePublishRelease({
    version: await readPackageVersion(),
    refName,
    ref,
  });
}
