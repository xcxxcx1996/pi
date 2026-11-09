#!/usr/bin/env node

// Downloads verified fd release binaries for every CELL desktop target and adds them to the package.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FD_VERSION = "10.5.1";
const TARGETS = [
	{
		platform: "darwin",
		arch: "arm64",
		assetTarget: "aarch64-apple-darwin.tar.gz",
		sha256: "2d336895ed27b14c5cc9fc5eb22df03b3ee842b5dce80060e99d9cdc1b1b9fc7",
	},
	{
		platform: "darwin",
		arch: "x64",
		assetTarget: "x86_64-apple-darwin.tar.gz",
		sha256: "308ac4fa5f53798b4e4bd77d243ba65e77b3eaae1ef2fe4e2a8a4bb2128eedff",
	},
	{
		platform: "linux",
		arch: "arm",
		assetTarget: "arm-unknown-linux-musleabihf.tar.gz",
		sha256: "8e9fe4f6e5a7eba0f0df84d859cbc7c5f2234da4a5287b50d6ece96ac627a758",
	},
	{
		platform: "linux",
		arch: "arm64",
		assetTarget: "aarch64-unknown-linux-musl.tar.gz",
		sha256: "64c20b9b154c9d4b36d4b7df3521de771c499c4768b4b5b045ef6b01532117be",
	},
	{
		platform: "linux",
		arch: "ia32",
		assetTarget: "i686-unknown-linux-musl.tar.gz",
		sha256: "cdbd21d11c3f8291d2c3ee56460ca51d9e9d1e01b4166e20095efcc52e18900f",
	},
	{
		platform: "linux",
		arch: "x64",
		assetTarget: "x86_64-unknown-linux-musl.tar.gz",
		sha256: "f6c95edb190c241df6fddc815a5bab4051444993ac5d92ddc6eec0e0dc2342c7",
	},
	{
		platform: "win32",
		arch: "arm64",
		assetTarget: "aarch64-pc-windows-msvc.zip",
		sha256: "39d0166d11ef01975fbc8fb92cf4c8e78afcda5ca0f64aa924f950f2baacd5e0",
	},
	{
		platform: "win32",
		arch: "ia32",
		assetTarget: "i686-pc-windows-msvc.zip",
		sha256: "f01fca35c63bc9d619f5959504c11bde9c22a1094c7fe9b40b6b193a71c79dbf",
	},
	{
		platform: "win32",
		arch: "x64",
		assetTarget: "x86_64-pc-windows-msvc.zip",
		sha256: "e52306a600e60b7ba92019c81dc753e6ea6665379d005867d38215ffd14cf5c2",
	},
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cacheDir = join(repoRoot, ".artifacts", "fd", FD_VERSION);
const outputDir = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "vendor", "fd");

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyArchive(path, expected) {
	const actual = sha256(path);
	if (actual !== expected) throw new Error(`Checksum mismatch for ${basename(path)}: expected ${expected}, got ${actual}`);
}

async function fetchRelease(url, assetName) {
	let lastError;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
			if (response.ok) return response;
			await response.body?.cancel();
			const error = new Error(`HTTP ${response.status}`);
			if (response.status < 500) throw error;
			lastError = error;
		} catch (error) {
			lastError = error;
		}
		if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2 ** attempt * 1_000));
	}
	throw new Error(`Failed to download ${assetName} after 4 attempts`, { cause: lastError });
}

async function downloadToPath(url, assetName, destination) {
	const curl = process.platform === "win32" ? "curl.exe" : "curl";
	const result = spawnSync(
		curl,
		[
			"--fail",
			"--location",
			"--silent",
			"--show-error",
			"--retry",
			"4",
			"--retry-all-errors",
			"--connect-timeout",
			"30",
			"--max-time",
			"300",
			"--output",
			destination,
			url,
		],
		{ encoding: "utf8", timeout: 360_000 },
	);
	if (!result.error && result.status === 0) return;
	try {
		const response = await fetchRelease(url, assetName);
		writeFileSync(destination, new Uint8Array(await response.arrayBuffer()));
	} catch (fetchError) {
		const reason = result.error?.message ?? (result.stderr.trim() || `exit status ${result.status ?? "unknown"}`);
		throw new Error(`Failed to download ${assetName} with curl and fetch: ${reason}`, { cause: fetchError });
	}
}

async function downloadArchive(assetName, expected) {
	mkdirSync(cacheDir, { recursive: true });
	const archivePath = join(cacheDir, assetName);
	if (existsSync(archivePath)) {
		verifyArchive(archivePath, expected);
		return archivePath;
	}

	const url = `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${assetName}`;
	const temporaryPath = `${archivePath}.${process.pid}.tmp`;
	await downloadToPath(url, assetName, temporaryPath);
	try {
		verifyArchive(temporaryPath, expected);
		renameSync(temporaryPath, archivePath);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
	return archivePath;
}

function runExtraction(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return !result.error && result.status === 0;
}

function extractArchive(archivePath, destination) {
	if (archivePath.endsWith(".tar.gz")) {
		if (!runExtraction("tar", ["xzf", archivePath, "-C", destination])) {
			throw new Error(`Failed to extract ${basename(archivePath)} with tar`);
		}
		return;
	}
	if (process.platform === "win32") {
		if (!runExtraction("tar.exe", ["xf", archivePath, "-C", destination])) {
			throw new Error(`Failed to extract ${basename(archivePath)} with tar.exe`);
		}
		return;
	}
	if (!runExtraction("unzip", ["-q", archivePath, "-d", destination])) {
		throw new Error(`Failed to extract ${basename(archivePath)} with unzip`);
	}
}

function findFile(root, name) {
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const nested = findFile(path, name);
			if (nested) return nested;
		}
	}
	return undefined;
}

rmSync(outputDir, { recursive: true, force: true });

for (const target of TARGETS) {
	const assetName = `fd-v${FD_VERSION}-${target.assetTarget}`;
	const archivePath = await downloadArchive(assetName, target.sha256);
	const temporaryDir = mkdtempSync(join(tmpdir(), "cell-fd-"));
	try {
		extractArchive(archivePath, temporaryDir);
		const binaryName = target.platform === "win32" ? "fd.exe" : "fd";
		const binaryPath = findFile(temporaryDir, binaryName);
		if (!binaryPath) throw new Error(`${binaryName} is missing from ${assetName}`);
		const targetDir = join(outputDir, `${target.platform}-${target.arch}`);
		mkdirSync(targetDir, { recursive: true });
		const targetPath = join(targetDir, binaryName);
		cpSync(binaryPath, targetPath);
		if (target.platform !== "win32") chmodSync(targetPath, 0o755);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

console.log(`Packaged fd ${FD_VERSION} for ${TARGETS.length} targets in ${outputDir}`);
