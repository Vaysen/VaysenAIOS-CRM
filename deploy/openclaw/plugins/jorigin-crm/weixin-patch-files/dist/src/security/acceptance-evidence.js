import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const MARKERS = {
    GROUP_REJECTED: /(?:^|[^A-Za-z0-9_])(JYACC_GROUP_[a-f0-9]{16})(?![A-Za-z0-9_])/,
    NON_OWNER_REJECTED: /(?:^|[^A-Za-z0-9_])(JYACC_NONOWNER_[a-f0-9]{16})(?![A-Za-z0-9_])/,
};
function assertRealDirectory(directory, label) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`${label} is unsafe`);
}
function ensureRestrictedDirectory(directory, parent) {
    assertRealDirectory(parent, "acceptance evidence parent");
    try {
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    assertRealDirectory(directory, "acceptance evidence directory");
    fs.chmodSync(directory, 0o700);
}
function extractTextBody(message) {
    if (!Array.isArray(message.item_list))
        return "";
    for (const item of message.item_list) {
        if (item?.text_item?.text != null)
            return String(item.text_item.text);
    }
    return "";
}
export function isDirectWeixinInbound(message) {
    if (!message || typeof message !== "object")
        return false;
    const groupId = message.group_id;
    return groupId === undefined || groupId === "";
}
export function recordWeixinAcceptanceRejection(message, outcome) {
    const match = MARKERS[outcome].exec(extractTextBody(message));
    if (!match)
        return null;
    const markerDigest = createHash("sha256").update(match[1], "utf8").digest("hex");
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir || !path.isAbsolute(stateDir))
        throw new Error("OPENCLAW_STATE_DIR is invalid");
    assertRealDirectory(stateDir, "OpenClaw state root");
    const evidenceRoot = path.join(stateDir, "acceptance-evidence");
    ensureRestrictedDirectory(evidenceRoot, stateDir);
    const channelRoot = path.join(evidenceRoot, "openclaw-weixin");
    ensureRestrictedDirectory(channelRoot, evidenceRoot);
    const evidencePath = path.join(channelRoot, `${markerDigest}.json`);
    const evidence = { schemaVersion: 1, markerDigest, outcome, observedAt: new Date().toISOString() };
    let fd;
    try {
        fd = fs.openSync(evidencePath, "wx", 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(evidence)}\n`, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.chmodSync(evidencePath, 0o600);
    }
    catch (error) {
        if (fd !== undefined)
            fs.closeSync(fd);
        if (error.code !== "EEXIST")
            throw error;
        const stat = fs.lstatSync(evidencePath);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("acceptance evidence path is unsafe");
        const existing = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
        if (existing?.markerDigest !== markerDigest || existing?.outcome !== outcome)
            throw new Error("acceptance evidence collision");
    }
    return { markerDigest, outcome, observedAt: evidence.observedAt };
}
