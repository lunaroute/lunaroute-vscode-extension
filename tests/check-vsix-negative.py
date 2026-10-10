"""Verify that a real user-key shape is rejected inside an otherwise-valid VSIX."""
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

with TemporaryDirectory(prefix="lunaroute-vsix-negative-") as directory:
    corrupted = Path(directory) / "credential.vsix"
    with ZipFile(sys.argv[1]) as original, ZipFile(corrupted, "w") as archive:
        for entry in original.infolist():
            data = original.read(entry)
            if entry.filename == "extension/readme.md":
                # Synthetic, deterministic bytes matching generateAPIKey's lr_ + 64 hex.
                data += b"\nlr_" + b"0123456789abcdef" * 4 + b"\n"
            archive.writestr(entry, data)
    checked = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("check-vsix.py")), str(corrupted)],
        capture_output=True, text=True, check=False,
    )
    assert checked.returncode != 0 and "Credential-shaped value" in checked.stderr, (
        "The archive checker did not reject a user-key-shaped value: " + checked.stdout + checked.stderr
    )
print("PASS VSIX checker rejects the actual user-key format")
