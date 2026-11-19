"""Return a KMS-protected workspace key to the launcher's private pipe."""
import base64
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def kms(operation, *args):
    # Capture output, including errors. Neither plaintext nor CLI diagnostics go into logs.
    result = subprocess.run(
        ["aws", "kms", operation, *args, "--output", "text", "--no-cli-pager"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=45,
    )
    if result.returncode:
        raise ValueError(f"KMS {operation} failed; check the key, region and host permissions")
    return base64.b64decode(result.stdout.strip(), validate=True)


def main():
    if sys.stdout.isatty():
        raise ValueError("Run this helper through the DevAgents launcher")
    key_arn, owner, existing = sys.argv[1:]
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", owner):
        raise ValueError("A bound workspace owner is required")
    if not re.fullmatch(r"arn:[a-z0-9-]+:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+", key_arn):
        raise ValueError("DEVAGENTS_KMS_KEY_ARN must identify a symmetric KMS key")
    if existing not in ("yes", "no"):
        raise ValueError("Could not determine the vault state")
    common = ["--region", key_arn.split(":")[3], "--key-id", key_arn,
              "--encryption-context", f"Application=DevAgents,Owner={owner}"]
    directory = Path(".devagents/kms")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    wrapped = directory / (owner + ".wrapped")
    if not wrapped.exists():
        if existing == "yes":
            raise ValueError("Existing vault requires its original wrapped key")
        encrypted = kms("generate-data-key-without-plaintext", *common, "--key-spec", "AES_256",
                        "--query", "CiphertextBlob")
        if not encrypted:
            raise ValueError("KMS returned an empty encrypted key")
        # An interrupted or concurrent first launch must never replace the selected key.
        with tempfile.NamedTemporaryFile(dir=directory) as staging:
            staging.write(encrypted)
            staging.flush()
            os.fsync(staging.fileno())
            try:
                os.link(staging.name, wrapped)
            except FileExistsError:
                pass
    plaintext = kms("decrypt", *common, "--ciphertext-blob", f"fileb://{wrapped.resolve()}",
                    "--query", "Plaintext")
    if len(plaintext) != 32:
        raise ValueError("KMS returned an invalid data key")
    sys.stdout.write(plaintext.hex())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        sys.exit(str(error))
