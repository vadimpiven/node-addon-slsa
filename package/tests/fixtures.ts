// SPDX-License-Identifier: Apache-2.0 OR MIT

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FAKE_BINARY = Buffer.from("fake native addon binary content");

export function testPkg(version: string) {
  return {
    name: "node-reqwest",
    version,
    addon: {
      path: "./dist/node_reqwest.node",
      url:
        "https://github.com/vadimpiven/node_reqwest/releases/download/" +
        "v{version}/node_reqwest-v{version}-{platform}-{arch}.node.gz",
    },
    repository: {
      url: "git+https://github.com/vadimpiven/node_reqwest.git",
    },
  };
}

export async function writeTestPkg(dir: string, version: string): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify(testPkg(version)));
}
