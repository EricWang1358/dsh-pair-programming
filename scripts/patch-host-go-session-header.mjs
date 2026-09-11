/** Explicit installed-host repair; never run from postinstall or verification. */
import { readFileSync, writeFileSync, copyFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
const target=process.argv[2];
if(!target)throw new Error('An explicit installed dsh-llm-pi-ai/lib/index.js path is required');
const original=readFileSync(target,'utf8');
const old=`function requestHeaders(headers) {
	const attribution = attributionHeaders();
	const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
	return {
		...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
		...attribution
	};
}`;
const replacement=`function requestHeaders(headers, sessionId) {
	const attribution = attributionHeaders();
	const reserved = new Set([...Object.keys(attribution).map((name) => name.toLowerCase()), "x-opencode-session", "x-deepseek-harness-session-id"]);
	return {
		...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
		...attribution,
		...(sessionId === void 0 || sessionId === null || String(sessionId).trim() === "" ? {} : {
			"x-opencode-session": String(sessionId),
			"x-deepseek-harness-session-id": String(sessionId)
		})
	};
}`;
const call='headers: requestHeaders(profile.headers)';
if(original.includes('headers: requestHeaders(profile.headers, options.sessionId)'))throw new Error('Already patched; inspect instead of applying twice');
if(original.split(old).length!==2||original.split(call).length!==2)throw new Error('Host source changed; refusing an unverified patch');
const updated=original.replace(old,replacement).replace(call,'headers: requestHeaders(profile.headers, options.sessionId)');
const backup=target+'.before-go-session-header.bak';
copyFileSync(target,backup,constants.COPYFILE_EXCL);
if(readFileSync(target,'utf8')!==original)throw new Error('Host source changed during preparation; backup retained, patch cancelled');
writeFileSync(target,updated);
console.log(JSON.stringify({target,backup,before:createHash('sha256').update(original).digest('hex'),after:createHash('sha256').update(updated).digest('hex')}));
