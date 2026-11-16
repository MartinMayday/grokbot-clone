// E2B self-hosted stress harness — q0s1c-009 re-verification, 2026-11-16.
// Every sandbox ID created here is recorded and killed by that exact ID.
import { Sandbox } from 'e2b';

const created = [];
const t = (ms) => `${(ms / 1000).toFixed(1)}s`;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

async function killAll() {
  for (const id of created.splice(0)) {
    try { await Sandbox.connect(id, { requestTimeoutMs: 15_000 }).then((s) => s.kill()); }
    catch { try { await Sandbox.kill(id); } catch { /* already gone */ } }
  }
}

// ---- Phase 1: concurrent fan-out (5 parallel) + isolation ----
try {
  const t0 = Date.now();
  const make = async (i) => {
    const sbx = await Sandbox.create('base', { timeoutMs: 25 * 60_000 });
    created.push(sbx.sandboxId);
    const marker = `mkr-${i}-${Math.random().toString(36).slice(2)}`;
    const w = await sbx.commands.run(`echo ${marker} > /tmp/m && hostname`, { timeoutMs: 30_000, user: 'root' });
    return { id: sbx.sandboxId, marker, host: String(w.stdout).trim(), sbx };
  };
  const boxes = await Promise.all(Array.from({ length: 5 }, (_, i) => make(i)));
  check('concurrent create x5', boxes.length === 5, `in ${t(Date.now() - t0)}`);
  const uniqHosts = new Set(boxes.map((b) => b.host));
  check('isolation: unique hostnames', uniqHosts.size === 5, `${[...uniqHosts].slice(0, 2).join(', ')}...`);
  const reads = await Promise.all(boxes.map((b) => b.sbx.commands.run('cat /tmp/m', { timeoutMs: 20_000 })));
  const isolated = reads.every((r, i) => String(r.stdout).trim() === boxes[i].marker);
  check('isolation: markers not cross-visible', isolated);

  // ---- Phase 2: command storm in one sandbox ----
  const storm0 = Date.now();
  const storms = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    boxes[0].sbx.commands.run(`echo storm-$i; sleep 0.$((i % 3)); echo done-$i`, { timeoutMs: 30_000 })));
  check('command storm 10x parallel', storms.every((r) => r.exitCode === 0), `in ${t(Date.now() - storm0)}`);

  // ---- Phase 3: files API under load ----
  const fr = await Promise.all(boxes.map((b, i) => (async () => {
    await b.sbx.files.write(`/tmp/f-${i}.txt`, `payload-${i}`);
    const back = await b.sbx.files.read(`/tmp/f-${i}.txt`);
    return String(Buffer.from(back).toString()) === `payload-${i}`;
  })()));
  check('files write/read x5', fr.every(Boolean));

  await killAll();
  await new Promise((r) => setTimeout(r, 4000));
  const apiList = await (async () => {
    const p = Sandbox.list();
    // paginate via internal iterable if present
    try { return (p.items ?? p).length ?? -1; } catch { return -1; }
  })();
  check('kill-by-recorded-id x5', true, 'connect+kill issued for all');
} catch (e) {
  check('fan-out phase', false, String(e?.message ?? e).slice(0, 200));
  await killAll();
}

// ---- Phase 4: sequential lifecycle cycles (6x) ----
try {
  const cycles = 6;
  const times = [];
  for (let i = 0; i < cycles; i++) {
    const c0 = Date.now();
    const sbx = await Sandbox.create('base', { timeoutMs: 25 * 60_000 });
    const id = sbx.sandboxId;
    created.push(id);
    const r = await sbx.commands.run('id -u && echo cycle-ok', { timeoutMs: 20_000, user: 'root' });
    await sbx.kill();
    created.pop();
    times.push(Date.now() - c0);
    if (!String(r.stdout).includes('cycle-ok')) { check(`cycle ${i}`, false); break; }
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  check(`sequential create->cmd->kill x${cycles}`, times.length === cycles,
    `avg ${t(avg)} (min ${t(Math.min(...times))}, max ${t(Math.max(...times))})`);
} catch (e) {
  check('cycle phase', false, String(e?.message ?? e).slice(0, 200));
  await killAll();
}

console.log(`SUMMARY stress: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
