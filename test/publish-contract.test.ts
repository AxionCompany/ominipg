import { assertThrows } from "@std/assert";
import { validatePublishRelease } from "../scripts/validate_publish_release.ts";

Deno.test("publish contract permits only the exact package version tag", () => {
  validatePublishRelease({
    version: "0.9.0-rc.4",
    refName: "v0.9.0-rc.4",
    ref: "refs/tags/v0.9.0-rc.4",
  });

  assertThrows(
    () =>
      validatePublishRelease({
        version: "0.9.0-rc.4",
        refName: "v0.9.0-rc.4",
        ref: "refs/heads/release/0.9.0-rc.4",
      }),
    Error,
    "Refusing to publish",
  );
  assertThrows(
    () =>
      validatePublishRelease({
        version: "0.9.0-rc.4",
        refName: "v0.9.0-rc.3",
        ref: "refs/tags/v0.9.0-rc.3",
      }),
    Error,
    "Refusing to publish",
  );
});
