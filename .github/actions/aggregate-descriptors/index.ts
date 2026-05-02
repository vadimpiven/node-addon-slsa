// SPDX-License-Identifier: Apache-2.0 OR MIT

import { getInput, info, setFailed, setOutput } from "@actions/core";

import {
  AddonDescriptorListSchema,
  buildAddonUrlMapFromDescriptors,
  errorMessage,
} from "@node-addon-slsa/internal";

export function aggregate(descriptorsJson: string, releaseBaseUrl: string): string {
  if (!releaseBaseUrl.startsWith("https://")) {
    throw new Error(`release-base-url must start with https://, got: ${releaseBaseUrl}`);
  }
  const normalized = releaseBaseUrl.endsWith("/") ? releaseBaseUrl : `${releaseBaseUrl}/`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptorsJson);
  } catch (e) {
    throw new Error(`descriptors input is not valid JSON: ${errorMessage(e)}`);
  }
  const descriptors = AddonDescriptorListSchema.parse(parsed);

  for (const d of descriptors) {
    for (const [field, value] of [
      ["url", d.url],
      ["bundleUrl", d.bundleUrl],
    ] as const) {
      if (!value.startsWith(normalized)) {
        throw new Error(
          `descriptor ${d.platform}/${d.arch} ${field} '${value}' does not start with ` +
            `release-base-url '${normalized}'`,
        );
      }
    }
  }

  return JSON.stringify(buildAddonUrlMapFromDescriptors(descriptors));
}

export async function main(): Promise<void> {
  const descriptorsJson = getInput("descriptors", { required: true });
  const releaseBaseUrl = getInput("release-base-url", { required: true });
  const descriptorCount = (JSON.parse(descriptorsJson) as unknown[]).length;
  const addons = aggregate(descriptorsJson, releaseBaseUrl);
  info(`Aggregated ${descriptorCount} descriptor(s).`);
  setOutput("addons", addons);
}

if (!process.env["VITEST"]) {
  try {
    await main();
  } catch (error) {
    setFailed(errorMessage(error));
  }
}
