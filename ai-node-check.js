/*
* AI 节点质量检测（Quantumult X · event-interaction 脚本）
* 版本：v2.1（2026-11-14）
*
* 说明：v2.0 试过用 opts.policy 在一次运行里串行测四个地区，真机上跑不通，已回滚该做法。
* v2.1 = v1.1 已验证可用的检测路径 + 更详细的报告（状态码、延迟采样、AS 号）。
*
* 用法：
* 1. 把本文件存到「我的 iPhone → Quantumult X → Scripts」文件夹（覆盖旧版即可）；
* 2. 配置文件 [task_local] 里已有对应一行（tag=AI节点质量检测），不用改；
* 3. 测单个节点/地区：开着圈X，在节点列表里某个节点或策略组
* （如「美国节点」「日本节点」「狮城节点」「加拿大节点」组）→ 选「AI节点质量检测」，
* 报告测的就是那个出口；
* 想看四个地区，就对四个地区组各长按运行一次，四条通知就是四份结果。
* 4. 在「工具 → HTTP 请求」里直接点运行 = 测当前「AI服务」选中的出口。
*
* 检测内容：
* - 出口 IP、城市、运营商、AS，以及 ip-api 的 proxy / hosting 标记（判断 IP 干不干净）
* - 延迟：3 次采样，给出 平均 / 最小 / 最大（看抖动）
* - 七家 AI 可达性 + 每家状态码：ChatGPT / Claude / Gemini / Copilot / Perplexity / Grok / Muse
* （ChatGPT、Claude 同时测 API 和网页两条探针，分开列）
*
* 判定逻辑（未登录探针，看返回码）：
* - OpenAI / Anthropic 官方 API 未带密钥访问返回 401 = 通且没被地区封；403 = 被封/地区限制
* - 网页端返回 200 / 3xx = 可用；403 = 被风控拦截（会结合 API 结果区分）
*/

var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
var TIMEOUT = 15000;

function fetchWithTimeout(opts) {
return Promise.race([
$task.fetch(opts),
new Promise(function (_, reject) {
setTimeout(function () { reject(new Error("timeout"));}, TIMEOUT);
})
]);
}

function get(url) {
return fetchWithTimeout({
url: url,
method: "GET",
headers: { "User-Agent": UA}
}).then(function (resp) {
return { ok: true, status: resp.statusCode, body: resp.body || ""};
}).catch(function (e) {
return { ok: false, status: 0, body: "", error: String(e && e.error? e.error: e)};
});
}

function timedGet(url) {
var t0 = Date.now();
return get(url).then(function (r) {
r.ms = Date.now() - t0;
return r;
});
}

function nodeLabel() {
try {
var p = $environment && $environment.params;
if (!p) return "";
if (typeof p === "string") return p;
return p.tag || p.name || p.server || "";
} catch (e) {
return "";
}
}

function judgeApi(r) {
if (!r.ok) return { icon: "❌", text: "不可达/超时"};
if (r.status === 401) return { icon: "✅", text: "可用"};
if (r.status === 403) return { icon: "❌", text: "被封/地区限制"};
return { icon: "⚠️", text: "异常(" + r.status + ")"};
}

function judgeWeb(r) {
if (!r.ok) return { icon: "❌", text: "不可达/超时"};
if (r.status >= 200 && r.status < 400) return { icon: "✅", text: "可用"};
if (r.status === 403) return { icon: "⚠️", text: "网页被风控(403)"};
return { icon: "⚠️", text: "异常(" + r.status + ")"};
}

function main() {
var label = nodeLabel();
var exitIP = "", exitLoc = "";
var ipInfo = null;
var probes = null;
var latSamples = [];

// 1) 出口 IP：chatgpt.com 的 trace 走 AI 分流，拿到的就是被测节点的出口
return timedGet("https://chatgpt.com/cdn-cgi/trace").then(function (tr) {
if (tr.ok && tr.body) {
var mIP = tr.body.match(/ip=([^\n]+)/);
var mLoc = tr.body.match(/loc=([^\n]+)/);
if (mIP) exitIP = mIP[1].trim();
if (mLoc) exitLoc = mLoc[1].trim();
}
if (!exitIP) {
return get("http://ip-api.com/json/?lang=zh-CN&fields=status,query,country,regionName,city,isp,org,as,proxy,hosting,mobile").then(function (r) {
if (r.ok) {
try {
ipInfo = JSON.parse(r.body);
exitIP = ipInfo.query || "";
} catch (e) {}
}
});
}
}).then(function () {
// 2) 出口 IP 的质量标记（数据库查询，不需要走节点）
if (exitIP &&!ipInfo) {
return get("http://ip-api.com/json/" + exitIP + "?lang=zh-CN&fields=status,country,regionName,city,isp,org,as,proxy,hosting,mobile").then(function (r) {
if (r.ok) {
try { ipInfo = JSON.parse(r.body);} catch (e) {}
}
});
}
}).then(function () {
// 3) 九条探针并行（七家 AI，ChatGPT/Claude 各含 API + 网页）
return Promise.all([
timedGet("https://api.openai.com/v1/models"), // 0 ChatGPT API
timedGet("https://chatgpt.com/"), // 1 ChatGPT 网页
timedGet("https://api.anthropic.com/v1/models"), // 2 Claude API
timedGet("https://claude.ai/"), // 3 Claude 网页
timedGet("https://gemini.google.com/"), // 4 Gemini
timedGet("https://copilot.microsoft.com/"), // 5 Copilot
timedGet("https://www.perplexity.ai/"), // 6 Perplexity
timedGet("https://grok.com/"), // 7 Grok
timedGet("https://muse.ai/") // 8 Muse
]).then(function (res) { probes = res;});
}).then(function () {
// 4) 延迟 3 次采样（串行）
var chain = Promise.resolve();
[1, 2, 3].forEach(function () {
chain = chain.then(function () {
return timedGet("http://cp.cloudflare.com/generate_204").then(function (r) {
if (r.ok) latSamples.push(r.ms);
});
});
});
return chain;
}).then(function () {
var p = probes;
var gptApi = judgeApi(p[0]);
var claudeApi = judgeApi(p[2]);
var claudeWeb = judgeWeb(p[3]);
var claude;
if (claudeApi.icon === "✅" && claudeWeb.icon === "✅") {
claude = { icon: "✅", text: "可用（网页+API）"};
} else if (claudeApi.icon === "✅") {
claude = { icon: "⚠️", text: "API通、网页被拦"};
} else {
claude = claudeApi;
}

var rows = [
{ name: "ChatGPT", j: gptApi, ms: p[0].ms, detail: "API " + (p[0].status || "无响应") + " · 网页 " + (p[1].status || "无响应")},
{ name: "Claude", j: claude, ms: p[2].ms, detail: "API " + (p[2].status || "无响应") + " · 网页 " + (p[3].status || "无响应")},
{ name: "Gemini", j: judgeWeb(p[4]), ms: p[4].ms, detail: "状态码 " + (p[4].status || "无响应")},
{ name: "Copilot", j: judgeWeb(p[5]), ms: p[5].ms, detail: "状态码 " + (p[5].status || "无响应")},
{ name: "Perplexity", j: judgeWeb(p[6]), ms: p[6].ms, detail: "状态码 " + (p[6].status || "无响应")},
{ name: "Grok", j: judgeWeb(p[7]), ms: p[7].ms, detail: "状态码 " + (p[7].status || "无响应")},
{ name: "Muse", j: judgeWeb(p[8]), ms: p[8].ms, detail: "状态码 " + (p[8].status || "无响应")}
];

var pass = 0;
var lines = [];
rows.forEach(function (row) {
if (row.j.icon === "✅") pass++;
lines.push(row.j.icon + " " + row.name + "：" + row.j.text + " · " + row.ms + "ms（" + row.detail + "）");
});

// 出口信息
var ipLine = "出口：" + (exitIP || "未知");
var clean = false;
if (ipInfo && ipInfo.status === "success") {
ipLine += "（" + (ipInfo.city || "") + ", " + (ipInfo.country || exitLoc) + "）";
ipLine += "\n运营商：" + (ipInfo.isp || ipInfo.org || "未知");
if (ipInfo.as) ipLine += "\nAS：" + ipInfo.as;
var flags = [];
if (ipInfo.hosting) flags.push("机房IP");
if (ipInfo.proxy) flags.push("被标记代理");
if (ipInfo.mobile) flags.push("移动网络");
clean =!ipInfo.proxy &&!ipInfo.hosting;
ipLine += "\nIP标记：" + (flags.length? flags.join("、"): "干净（无机房/代理标记）");
} else if (exitLoc) {
ipLine += "（地区 " + exitLoc + "，IP详情查询失败）";
}

// 延迟统计
var latLine = "";
if (latSamples.length) {
var sum = 0, min = latSamples[0], max = latSamples[0];
latSamples.forEach(function (v) { sum += v; if (v < min) min = v; if (v > max) max = v;});
latLine = "\n延迟采样：平均 " + Math.round(sum / latSamples.length) + "ms（最小 " + min + " / 最大 " + max + "，抖动 " + (max - min) + "ms）";
}

var grade;
if (pass >= 7 && clean) grade = "优 · 全通且IP干净";
else if (pass >= 6) grade = "良 · 基本可用";
else if (pass >= 4) grade = "中 · 部分AI不可用";
else grade = "差 · 多数AI不可用，不建议当AI出口";

var title = "AI节点质量检测" + (label? " · " + label: "");
var body = ipLine + latLine + "\n———\n" + lines.join("\n") + "\n———\n综合：" + grade + "（" + pass + "/7 可用）";

console.log(title + "\n" + body);
$notify(title, "可用 " + pass + "/7 · " + grade, body);
$done();
}).catch(function (e) {
$notify("AI节点质量检测", "脚本出错", String(e));
$done();
});
}

main();
