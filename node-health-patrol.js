/*
* 节点健康巡检（Quantumult X · cron 脚本）
* 版本：v1.0（2026-11-14）
*
* 每天 8:00 和 20:00（晚高峰）各巡检一次 AI 在用的关键节点：
* 逐个测 出口IP/延迟 + Claude API 是否通。只在状态变化时通知：
* - 节点挂了（连不上，或 Claude 不通）
* - 节点恢复
* - 出口 IP 变了（机场换落地要第一时间知道）
* 全部正常时不发通知（结果只记日志）。首次运行会发一份基线报告。
*
* 任务行（配置文件 [task_local]）：
* 0 8,20 * * * <本脚本地址>, tag=节点健康巡检, enabled=true
*/

var TARGETS = ["[美国] 移动", "[美国] 原生₄", "[美国] 原生₆"];
var STORE_KEY = "node_patrol_v1";
var TIMEOUT = 12000;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function get(url, policy) {
return Promise.race([
$task.fetch({ url: url, method: "GET", headers: { "User-Agent": UA}, opts: { policy: policy}}),
new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout"));}, TIMEOUT);})
]).then(function (resp) {
return { ok: true, status: resp.statusCode, body: resp.body || ""};
}).catch(function (e) {
return { ok: false, status: 0, body: ""};
});
}

function checkNode(name) {
var t0 = Date.now();
return get("https://chatgpt.com/cdn-cgi/trace", name).then(function (tr) {
var ms = Date.now() - t0;
var ip = "";
if (tr.ok && tr.body) {
var m = tr.body.match(/ip=([^\n]+)/);
if (m) ip = m[1].trim();
}
if (!ip) return { name: name, ok: false, why: "连不上", ip: "", ms: 0};
return get("https://api.anthropic.com/v1/models", name).then(function (r) {
var claudeOk = r.ok && r.status === 401;
return {
name: name, ok: claudeOk, ip: ip, ms: ms,
why: claudeOk? "": "Claude异常(" + (r.status || "无响应") + ")"
};
});
});
}

function loadStore() {
try { return JSON.parse($persistentStore.read(STORE_KEY) || "{}");} catch (e) { return {};}
}
function saveStore(o) {
try { $persistentStore.write(JSON.stringify(o), STORE_KEY);} catch (e) {}
}

var results = [];
var chain = Promise.resolve();
TARGETS.forEach(function (name) {
chain = chain.then(function () {
return checkNode(name).then(function (r) { results.push(r);});
});
});

chain.then(function () {
var store = loadStore();
var first = !store.booted;
var states = store.states || {};
var events = [];
var lines = [];
results.forEach(function (r) {
lines.push((r.ok? "✅ ": "🔴 ") + r.name + (r.ok? (" · " + r.ip + " · " + r.ms + "ms"): (" · " + r.why)));
var prev = states[r.name];
if (!first && prev) {
if (prev.ok && !r.ok) events.push("🔴 " + r.name + " 挂了：" + r.why);
else if (!prev.ok && r.ok) events.push("🟢 " + r.name + " 已恢复（" + r.ip + "）");
else if (r.ok && prev.ip && r.ip && prev.ip !== r.ip) events.push("🟡 " + r.name + " 出口IP变了：" + prev.ip + " → " + r.ip);
}
states[r.name] = { ok: r.ok, ip: r.ip};
});
store.states = states;
console.log(lines.join("\n"));
if (first) {
store.booted = true;
$notify("节点健康巡检 · 已开启", "每天 8:00 / 20:00 巡检，只在异常时提醒", lines.join("\n"));
} else if (events.length) {
$notify("节点健康巡检", events.join("；"), lines.join("\n"));
}
saveStore(store);
$done();
}).catch(function (e) {
console.log("patrol error: " + e);
$done();
});
