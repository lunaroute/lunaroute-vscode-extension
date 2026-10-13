"""Check the actual ZIP artifact, not only the package manifest. Uses Python's stdlib."""
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

required = {
    "[Content_Types].xml", "extension.vsixmanifest", "extension/package.json",
    "extension/readme.md", "extension/LICENSE.txt", "extension/THIRD_PARTY_NOTICES.txt",
    "extension/dist/extension.cjs",
}
optional = {"extension/dist/extension.cjs.LEGAL.txt"}
with ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)), "Duplicate archive paths"
    assert required <= set(names), "Missing runtime/documentation/legal files"
    assert set(names) <= required | optional, "Unexpected archive files: " + repr(set(names) - required - optional)
    manifest = json.loads(archive.read("extension/package.json"))
    assert manifest["main"] == "./dist/extension.cjs"
    assert manifest["extensionKind"] == ["ui"]
    assert "browser" not in manifest and "enabledApiProposals" not in manifest
    assert manifest["contributes"]["languageModelChatProviders"][0]["vendor"] == "lunaroute"
    # The MCP provider id must be declared or the host rejects the registration at runtime.
    assert manifest["contributes"]["mcpServerDefinitionProviders"][0]["id"] == "lunaroute.mcp"
    notices = archive.read("extension/THIRD_PARTY_NOTICES.txt")
    root = Path(__file__).resolve().parent.parent
    for license_path in ["LICENSE", "src/_vendor/partial-json-parser/LICENSE", "src/internal/qs/LICENSE.md"]:
        license_text = (root / "node_modules/openai" / license_path).read_bytes().strip()
        assert license_text in notices, "Missing bundled third-party license: " + license_path
    assert archive.read("extension/LICENSE.txt") == (root / "LICENSE").read_bytes()
    for name in names:
        data = archive.read(name)
        for canary in [b"lr_host_fixture_", b"lr_provider_fixture_", b"lr_fake_DO_NOT_LOG", b"private_probe_prompt_or_tool_content", b"startGatewayFixture", b"lunaroute-probe"]:
            assert canary not in data, "Test fixture/canary leaked into " + name
        assert not re.search(rb"lr_(?:[0-9a-f]{64}|(?:live|platform)_[A-Za-z0-9_-]{16,})", data), "Credential-shaped value in " + name
print("PASS VSIX file allowlist, runtime manifest, full license texts and fixture/credential canary scan")
