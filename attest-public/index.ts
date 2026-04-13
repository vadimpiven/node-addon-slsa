// SPDX-License-Identifier: Apache-2.0 OR MIT

import { getInput, setFailed, setOutput } from "@actions/core";
import { attestProvenance, type Subject } from "@actions/attest";
import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";

try {
  const subjectPath: string = getInput("subject-path", {
    required: true,
  });
  const token: string = getInput("github-token", {
    required: true,
  });

  const files: string[] = [];
  for await (const file of glob(subjectPath)) {
    files.push(file);
  }
  if (files.length === 0) {
    throw new Error(`no files matched: ${subjectPath}`);
  }

  const subjects: Subject[] = await Promise.all(
    files.map(async (file: string): Promise<Subject> => {
      const content: Buffer = await readFile(file);
      const sha256: string = createHash("sha256").update(content).digest("hex");
      return { name: file, digest: { sha256 } };
    }),
  );

  const result = await attestProvenance({
    subjects,
    token,
    sigstore: "public-good",
  });

  setOutput("attestation-id", result.attestationID);
} catch (error: unknown) {
  setFailed(error instanceof Error ? error.message : String(error));
}
