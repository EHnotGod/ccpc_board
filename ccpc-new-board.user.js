// ==UserScript==
// @name         CCPC 新模式榜单
// @namespace    ccpc-board
// @homepageURL  https://github.com/EHnotGod/ccpc_board
// @supportURL   https://github.com/EHnotGod/ccpc_board/issues
// @version      0.1.1
// @description  复用 CCPC 外榜，按通过队数公开题号，并支持匿名进度、时间回放和四小时封榜。
// @match        https://rank.iccpc.cn/r/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '0.1.1';
    const FREEZE_SECONDS = 4 * 60 * 60;

    function isContestant(team) {
        const privilege = String(team?.privilege || '').trim().toLowerCase();
        return privilege === '' || privilege === 'default';
    }

    function revealThreshold(teams) {
        const list = Array.isArray(teams) ? teams : Object.values(teams || {});
        const official = list.filter(t => isContestant(t) && Number(t.tkind || 0) !== 2).length;
        return Math.ceil(Math.min(50, official * 0.2));
    }

    function hasLetter(problem) {
        return problem && problem.num != null && problem.num !== '' && Number.isFinite(Number(problem.num));
    }

    function revealProblems(problems, rows, threshold, showAll) {
        const accepted = new Map();
        for (const row of rows || []) {
            if (!isContestant(row.team)) continue;
            for (const [id, stats] of Object.entries(row.problemStats || {})) {
                if (stats.status !== 'ac') continue;
                if (!accepted.has(id)) accepted.set(id, new Set());
                accepted.get(id).add(String(row.team_id));
            }
        }
        const revealed = new Set();
        for (const p of Array.isArray(problems) ? problems : Object.values(problems || {})) {
            if (hasLetter(p) && (showAll || (accepted.get(String(p.problem_id))?.size || 0) >= threshold)) {
                revealed.add(String(p.problem_id));
            }
        }
        return revealed;
    }

    function elapsedSeconds(value) {
        if (typeof value !== 'string' || !/^\d+:\d{2}(?::\d{2})?$/.test(value)) return Infinity;
        return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
    }

    function orderProblems(problemMap, stats, revealed) {
        const publicIds = Object.keys(problemMap || {})
            .filter(id => revealed.has(id))
            .sort((a, b) => Number(problemMap[a].num) - Number(problemMap[b].num));
        const privateIds = Object.keys(stats || {}).filter(id => {
            const s = stats[id];
            return !revealed.has(id) && (s.submitCount > 0 || s.submissionHistory?.length > 0 || ['ac', 'wa', 'pending'].includes(s.status));
        });
        privateIds.sort((a, b) => {
            const x = stats[a], y = stats[b];
            const statusOrder = Number(y.status === 'ac') - Number(x.status === 'ac');
            if (statusOrder) return statusOrder;
            const tx = elapsedSeconds(x.lastSubmitTime), ty = elapsedSeconds(y.lastSubmitTime);
            return tx === ty ? 0 : tx - ty;
        });
        return { publicIds, privateIds };
    }

    function sanitizeHistory(history, hidden, isFrozen = () => false) {
        return (Array.isArray(history) ? history : []).map(row => {
            const keys = hidden ? ['in_date', 'result', 'language']
                : ['solution_id', 'contest_id', 'problem_id', 'in_date', 'result', 'language'];
            const safe = {};
            for (const key of keys) if (Object.hasOwn(row, key)) safe[key] = row[key];
            if (isFrozen(row)) safe.result = -1;
            return safe;
        });
    }

    const rules = { revealThreshold, revealProblems, orderProblems, sanitizeHistory, elapsedSeconds };
    if (typeof module === 'object' && module.exports) {
        module.exports = rules;
        return;
    }
    if (!/^\/r\/[^/]+\/?$/.test(location.pathname) || window.CCPCNewBoard) return;

    const STORAGE_KEY = 'ccpc-new-board:enabled';
    let enabled = true;
    try { enabled = localStorage.getItem(STORAGE_KEY) !== '0'; } catch (_) { /* 默认开启 */ }
    const state = { version: VERSION, enabled, instance: null };
    window.CCPCNewBoard = state;
    const installed = new WeakSet();
    let baseClass;

    function contestStart(rs) {
        return rs.data?.contest?.start_time ? rs._rankWireInstantMs(rs.data.contest.start_time) : NaN;
    }

    function viewTime(rs) {
        if (rs.timeReplayMode && rs.replayTime) return Number(rs.replayTime);
        const now = Number(rs.GetActualCurrentTime());
        const end = rs.data?.contest?.end_time ? rs._rankWireInstantMs(rs.data.contest.end_time) : NaN;
        return Number.isFinite(end) ? Math.min(now, end) : now;
    }

    function showAll(rs) {
        return viewTime(rs) - contestStart(rs) >= FREEZE_SECONDS * 1000;
    }

    function problemTotal(rs) {
        return Math.max(Object.keys(rs.problemMap || {}).length, Number(rs.data?.ccpc_meta?.n_problems) || 0);
    }

    function safeProblem(problem) {
        const safe = Object.assign({}, problem, { color: '' });
        delete safe.accepted;
        delete safe.submit;
        delete safe.frozen_submit;
        return safe;
    }

    function visibleSolutions(rs) {
        const cutoff = viewTime(rs);
        return (rs._submissionSource || rs.data?.solution || [])
            .filter(row => rs._rankWireInstantMs(row.in_date) <= cutoff);
    }

    function formatElapsed(seconds) {
        const s = Math.max(0, Math.floor(seconds));
        return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
            .map(n => String(n).padStart(2, '0')).join(':');
    }

    function replayBounds(rs) {
        if (!rs?.contestStartTime || !rs.contestEndTime) return null;
        const start = Number(rs.contestStartTime), end = Number(rs.contestEndTime);
        const now = Number(rs.GetActualCurrentTime());
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) return null;
        const latest = Math.max(start, Math.min(end, now));
        const time = rs.timeReplayMode && rs.replayTime ? Number(rs.replayTime) : latest;
        const current = Math.max(start, Math.min(latest, time));
        return { start, end, latest, current };
    }

    function syncReplayControls() {
        const rs = state.instance;
        const bounds = enabled ? replayBounds(rs) : null;
        const back = document.getElementById('ccpc-replay-back');
        const forward = document.getElementById('ccpc-replay-forward');
        if (back) back.disabled = !bounds || bounds.current <= bounds.start;
        if (forward) forward.disabled = !bounds || bounds.current >= bounds.latest;
        if (!bounds) return;
        const slider = rs.GetHeaderElement()?.querySelector('#time-progress-slider');
        if (!slider) return;
        // 原站使用百分比范围；按比赛时长换算，让每一格对应 60 秒。
        const step = String(60000 / (bounds.end - bounds.start) * 100);
        if (slider.step !== step) slider.step = step;
    }

    function shiftReplay(minutes) {
        const rs = state.instance;
        const bounds = enabled ? replayBounds(rs) : null;
        if (!bounds) return;
        const target = Math.max(bounds.start, Math.min(bounds.latest, bounds.current + minutes * 60000));
        if (target === bounds.current) return;
        if (target >= bounds.latest) {
            rs.ResetTimeReplay();
        } else {
            rs.replayTime = new Date(target);
            const slider = rs.GetHeaderElement()?.querySelector('#time-progress-slider');
            if (slider) slider.value = String((target - bounds.start) / (bounds.end - bounds.start) * 100);
            rs.ApplyTimeReplay();
        }
        syncReplayControls();
    }

    // 原站不把 CE / 评测中的提交计入罚时。补充展示这些提交，排名仍由原站计算。
    function includeAllAttempts(rs) {
        const rows = new Map((rs.rankList || []).map(row => [String(row.team_id), row]));
        const grouped = new Map();
        for (const sol of visibleSolutions(rs)) {
            const row = rows.get(String(sol.team_id));
            if (!row) continue;
            const id = String(sol.problem_id);
            const key = JSON.stringify([String(sol.team_id), id]);
            if (!grouped.has(key)) grouped.set(key, { row, id, history: [] });
            grouped.get(key).history.push(sol);
        }
        const start = contestStart(rs);
        for (const { row, id, history } of grouped.values()) {
            history.sort((a, b) => rs._rankWireInstantMs(a.in_date) - rs._rankWireInstantMs(b.in_date)
                || Number(a.solution_id || 0) - Number(b.solution_id || 0));
            const current = row.problemStats[id];
            const ac = current?.status === 'ac'
                ? history.findIndex(sol => Number(sol.result) === 4 && !rs.IsFrozen(sol)) : -1;
            const attempts = ac < 0 ? history : history.slice(0, ac + 1);
            if (!attempts.length) continue;
            const last = attempts[attempts.length - 1];
            const pending = attempts.some(sol => rs.IsFrozen(sol) || Number(sol.result) < 4);
            row.problemStats[id] = Object.assign({}, current, {
                status: current?.status === 'ac' ? 'ac' : pending ? 'pending' : 'wa',
                submitCount: attempts.length,
                lastSubmitTime: formatElapsed((rs._rankWireInstantMs(last.in_date) - start) / 1000),
                submissionHistory: attempts,
                problemAlphabetIdx: hasLetter(rs.problemMap[id]) ? rs.GetProblemAlphabetIdx(rs.problemMap[id].num) : ''
            });
        }
    }

    function resultStats(rs) {
        const map = {};
        const solutions = visibleSolutions(rs);
        const ids = new Set(Object.keys(rs.problemMap || {}));
        for (const sol of solutions) ids.add(String(sol.problem_id));
        for (const id of ids) {
            map[id] = { total: 0, ac: 0, wa: 0, tle: 0, mle: 0, re: 0, ce: 0, pe: 0, pending: 0 };
        }
        const keys = { 4: 'ac', 5: 'pe', 6: 'wa', 7: 'tle', 8: 'mle', 9: 're', 10: 're', 11: 'ce' };
        for (const sol of solutions) {
            const stats = map[sol.problem_id];
            if (!stats) continue;
            stats.total++;
            const key = rs.IsFrozen(sol) || Number(sol.result) < 4 ? 'pending' : keys[sol.result];
            if (key) stats[key]++;
        }
        return map;
    }

    function attach(rs) {
        if (rs.containerId !== 'rank-container') return;
        state.instance = rs;
        if (!enabled || installed.has(rs)) return;
        installed.add(rs);
        const originalFrozen = rs.IsFrozen;
        const originalHeader = rs.CreateProblemHeaderColumn;
        const originalPopover = rs.CreateProblemStatusPopoverAttrs;
        const describe = baseClass.prototype.DescribeProblemCell;

        for (const name of ['InitializeTimeProgress', 'ApplyTimeReplay', 'ResetTimeReplay']) {
            const original = rs[name];
            rs[name] = function () {
                const result = original.apply(this, arguments);
                syncReplayControls();
                return result;
            };
        }
        const setReplayTime = rs.SetReplayTime;
        rs.SetReplayTime = function () {
            const result = setReplayTime.apply(this, arguments);
            if (this.replayTime && this.contestStartTime) {
                const start = Number(this.contestStartTime);
                const elapsed = Number(this.replayTime) - start;
                const minute = Math.round(elapsed / 60000) * 60000;
                // range 的小数百分比可能造成毫秒误差，避免 1 分钟显示成 59 秒。
                if (Math.abs(elapsed - minute) < 10) this.replayTime = new Date(start + minute);
            }
            return result;
        };

        rs.IsFrozen = function (solution) {
            return originalFrozen.call(this, solution)
                || this._rankWireInstantMs(solution.in_date) - contestStart(this) >= FREEZE_SECONDS * 1000;
        };
        rs.CcpcShowAllLetters = function () { return showAll(this); };
        rs.GetProblemTotal = function () { return problemTotal(this); };
        rs.EnsureCcpcReveal = function () {
            const all = showAll(this);
            const threshold = revealThreshold(this.data?.team || this.teamMap);
            const key = this._ccpcUserRevealKey;
            if (key?.rows === this.rankList && key.data === this.data && key.all === all && key.threshold === threshold) return;
            this._ccpcRevealed = revealProblems(this.problemMap, this.rankList, threshold, all);
            this._ccpcRevealThreshold = threshold;
            this._ccpcUserRevealKey = { rows: this.rankList, data: this.data, all, threshold };
        };
        rs.CcpcPidRevealed = function (id) {
            this.EnsureCcpcReveal();
            return this._ccpcRevealed.has(String(id));
        };
        rs.GetProblemHeaderList = function () {
            this.EnsureCcpcReveal();
            return Object.values(this.problemMap || {}).filter(p => this._ccpcRevealed.has(String(p.problem_id)))
                .sort((a, b) => Number(a.num) - Number(b.num)).map(safeProblem);
        };
        rs.GetProblemColumnOrder = function (stats) {
            this.EnsureCcpcReveal();
            const { publicIds, privateIds } = orderProblems(this.problemMap, stats, this._ccpcRevealed);
            this._ccpcPublicLen = publicIds.length;
            return publicIds.concat(privateIds);
        };
        rs.GetSubmitCountDisplay = function (stats) { return stats.submitCount || stats.problemAlphabetIdx || ''; };
        rs.CreateProblemHeaderGroup = function () {
            const stats = this.CalculateProblemStats();
            const columns = this.GetProblemHeaderList().map(p => this.CreateProblemHeaderColumn(p, stats[p.problem_id])).join('');
            const hidden = problemTotal(this) - this.GetProblemHeaderList().length;
            return '<div class="pro-header-group"><div class="ccpc-public-zone">' + columns + '</div>'
                + (hidden > 0 ? '<div class="ccpc-zone-split" aria-hidden="true"></div><div class="ccpc-private-zone-head">未公开题目 · AC 优先</div>' : '') + '</div>';
        };
        rs.CreateProblemGroup = function (stats, item) {
            this.EnsureCcpcReveal();
            const { publicIds, privateIds } = orderProblems(this.problemMap, stats, this._ccpcRevealed);
            const cells = ids => ids.map(id => this.CreateProblemColumnHtml(id, stats, item)).join('');
            const hidden = problemTotal(this) > publicIds.length || privateIds.length > 0;
            return '<div class="ccpc-public-zone">' + cells(publicIds) + '</div>'
                + (hidden ? '<div class="ccpc-zone-split" aria-hidden="true"></div><div class="ccpc-private-zone">' + cells(privateIds) + '</div>' : '');
        };
        rs.DescribeProblemCell = function (id, stats, item) {
            const hidden = !this.CcpcPidRevealed(id);
            const value = Object.assign({ status: 'none', submitCount: 0, lastSubmitTime: '' }, stats?.[id]);
            if (hidden) value.problemAlphabetIdx = '';
            const fb = this.map_fb;
            let descriptor;
            try {
                if (hidden) this.map_fb = { global: {}, regular: {} };
                descriptor = describe.call(this, id, Object.assign({}, stats, { [id]: value }), item);
            } finally { this.map_fb = fb; }
            descriptor.submissionHistory = sanitizeHistory(value.submissionHistory, hidden, sol => this.IsFrozen(sol));
            return descriptor;
        };
        rs.CreateProblemStatusPopoverAttrs = function (history, item) {
            return originalPopover.call(this, history, item) + ' data-ccpc-new-cell="1"';
        };
        rs.CreateProblemHeaderColumn = function (problem, stats) {
            // 原站优先使用题目自带的整场统计，回放时必须改用当前时刻的统计。
            return originalHeader.call(this, safeProblem(problem), stats);
        };
        rs.CalculateProblemStats = function () {
            const map = {};
            const acTeams = new Map(), teams = new Map();
            for (const id of Object.keys(this.problemMap || {})) {
                map[id] = { ac: 0, total: 0, acTeams: 0, totalTeams: 0 };
                acTeams.set(id, new Set());
                teams.set(id, new Set());
            }
            for (const sol of visibleSolutions(this)) {
                const id = String(sol.problem_id);
                if (!map[id]) continue;
                map[id].total++;
                teams.get(id).add(String(sol.team_id));
                if (Number(sol.result) === 4 && !this.IsFrozen(sol)) {
                    map[id].ac++;
                    acTeams.get(id).add(String(sol.team_id));
                }
            }
            for (const id of Object.keys(map)) {
                map[id].acTeams = acTeams.get(id).size;
                map[id].totalTeams = teams.get(id).size;
            }
            return map;
        };
        rs.CalculateSubmissionResultStats = function () { return resultStats(this); };
        rs.GenerateSummaryHtml = function () {
            this.EnsureCcpcReveal();
            const stats = resultStats(this);
            const columns = this.GetProblemHeaderList().map(p => ({
                label: this.GetProblemAlphabetIdx(p.num), ids: [String(p.problem_id)]
            }));
            const hidden = Object.keys(stats).filter(id => !this._ccpcRevealed.has(id));
            if (hidden.length) columns.push({ label: '未公开题目合计', ids: hidden });
            const types = ['ac', 'wa', 'tle', 'mle', 're', 'ce', 'pe', 'pending', 'total'];
            return '<table class="summary-table"><thead><tr><th>结果</th>'
                + columns.map(c => '<th>' + c.label + '</th>').join('') + '<th>合计</th></tr></thead><tbody>'
                + types.map(type => {
                    const counts = columns.map(c => c.ids.reduce((sum, id) => sum + (stats[id]?.[type] || 0), 0));
                    const label = type === 'pending' ? '等待 / 封榜' : type === 'total' ? '合计' : type.toUpperCase();
                    return '<tr><td>' + label + '</td>' + counts.map(n => '<td>' + n + '</td>').join('')
                        + '<td>' + counts.reduce((a, b) => a + b, 0) + '</td></tr>';
                }).join('') + '</tbody></table>';
        };
        // 原站的双击导出也只输出已经公开的题目列。
        rs._GetOrderedProblemIdsForExport = function () {
            return this.GetProblemHeaderList().map(p => String(p.problem_id));
        };
    }

    function patchPopover() {
        const original = window.RankProblemStatusPopoverContent;
        if (typeof original !== 'function' || original.__ccpcNewBoard) return;
        const wrapped = function (trigger) {
            const result = original.apply(this, arguments);
            if (!trigger?.hasAttribute('data-ccpc-new-cell') || !result?.html) return result;
            const history = JSON.parse(trigger.getAttribute('data-rank-solution-history') || '[]');
            const holder = document.createElement('div');
            holder.innerHTML = result.html;
            const penalty = holder.querySelector('.rank-problem-history-stat--penalty .rank-problem-history-stat-cn');
            if (penalty) {
                const errors = history.filter(s => Number(s.result) >= 5 && Number(s.result) <= 10).length;
                penalty.textContent = '20*' + errors + '=' + errors * 20;
            }
            // 原站原本不显示 CE / 评测中的记录，补全这两类记录的文案。
            const shown = history.map((s, i) => ({ s, no: i + 1 }));
            const visible = shown.length > 10 ? shown.slice(0, 5).concat(shown.slice(-5)) : shown;
            const rendered = [...holder.querySelectorAll('.rank-problem-history-row')];
            visible.reverse().forEach(({ s }, i) => {
                const cn = rendered[i]?.querySelector('.rank-problem-history-verdict-cn');
                const en = rendered[i]?.querySelector('.rank-problem-history-verdict-en');
                if (cn && Number(s.result) === 11) { cn.textContent = '编译错误'; en.textContent = 'Compilation Error'; }
                else if (cn && Number(s.result) >= 0 && Number(s.result) < 4) { cn.textContent = '评测中'; en.textContent = 'Judging'; }
            });
            return Object.assign({}, result, { html: holder.innerHTML });
        };
        wrapped.__ccpcNewBoard = true;
        window.RankProblemStatusPopoverContent = wrapped;
    }

    function patchClass(Ctor) {
        if (typeof Ctor !== 'function' || Object.hasOwn(Ctor, '__ccpcNewBoard')) return;
        Ctor.__ccpcNewBoard = true;
        baseClass = Ctor;
        const init = Ctor.prototype.Init;
        const process = Ctor.prototype.ProcessData;
        Ctor.prototype.Init = function () {
            attach(this);
            const result = init.apply(this, arguments);
            mountToolbar();
            return result;
        };
        Ctor.prototype.ProcessData = function () {
            attach(this);
            const result = process.apply(this, arguments);
            if (enabled && installed.has(this)) {
                includeAllAttempts(this);
                this._ccpcUserRevealKey = null;
                this._ccpcUserFreezePhase = showAll(this);
                updateStatus();
            }
            return result;
        };
        patchPopover();
    }

    function mountToolbar() {
        if (document.getElementById('ccpc-new-board-tools')) return;
        const anchor = document.querySelector('.or-rank__head');
        if (!anchor) return;
        const style = document.createElement('style');
        style.textContent = `
            #ccpc-new-board-tools { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:0 0 12px; font-size:13px; }
            #ccpc-new-board-status { opacity:.8; }
            #ccpc-new-board-tools button:disabled { opacity:.5; cursor:default; }
            .problem-group:has(.ccpc-public-zone), .pro-header-group:has(.ccpc-public-zone),
            .ccpc-public-zone, .ccpc-private-zone, .ccpc-private-zone-head {
                display:flex; flex-wrap:nowrap; gap:var(--rank-col-gap); min-width:0;
            }
            .ccpc-zone-split { width:1px; flex:0 0 1px; align-self:stretch; background:currentColor; opacity:.18; margin:0 2px; }
            .ccpc-private-zone-head { align-items:center; font-size:12px; white-space:nowrap; opacity:.65; }
            .ccpc-public-zone { flex-shrink:0; }
            .rank-system:has(.ccpc-public-zone) .problem-header-color-bg { display:none; }
        `;
        document.head.appendChild(style);
        const toolbar = document.createElement('div');
        toolbar.id = 'ccpc-new-board-tools';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--sm';
        button.textContent = enabled ? '新模式：已开启' : '新模式：已关闭';
        button.setAttribute('aria-pressed', String(enabled));
        button.addEventListener('click', () => {
            try { localStorage.setItem(STORAGE_KEY, enabled ? '0' : '1'); }
            catch (_) { button.textContent = '浏览器禁止保存设置'; return; }
            location.reload();
        });
        const status = document.createElement('span');
        status.id = 'ccpc-new-board-status';
        status.setAttribute('role', 'status');
        toolbar.append(button);
        for (const [id, label, minutes] of [
            ['ccpc-replay-back', '−1 分钟', -1],
            ['ccpc-replay-forward', '+1 分钟', 1]
        ]) {
            const control = document.createElement('button');
            control.id = id;
            control.type = 'button';
            control.className = 'btn btn--sm';
            control.textContent = label;
            control.disabled = true;
            control.setAttribute('aria-label', minutes < 0 ? '回放时间后退 1 分钟' : '回放时间前进 1 分钟');
            control.addEventListener('click', () => shiftReplay(minutes));
            toolbar.append(control);
        }
        toolbar.append(status);
        anchor.after(toolbar);
        syncReplayControls();
        updateStatus();
    }

    function updateStatus() {
        const el = document.getElementById('ccpc-new-board-status');
        if (!el) return;
        const rs = state.instance;
        if (!enabled) { el.textContent = '显示原站榜单'; return; }
        if (!rs?.data) { el.textContent = '等待榜单数据…'; return; }
        rs.EnsureCcpcReveal();
        const teams = rs.data.team || [];
        const official = teams.filter(t => isContestant(t) && Number(t.tkind || 0) !== 2).length;
        const total = Number(rs.data.ccpc_meta?.n_problems) || Object.keys(rs.problemMap).length;
        const phase = showAll(rs) ? '已封榜' : rs.timeReplayMode ? '回放中' : '新模式';
        const message = `${phase} · 正式队 ${official} · ${rs._ccpcRevealThreshold} 队通过后公开 · 已公开 ${rs._ccpcRevealed.size}/${total}`;
        if (el.textContent !== message) el.textContent = message;
    }

    // 页面工厂不把实例留在全局；在类赋值时接入，避免创建第二个榜单实例。
    const descriptor = Object.getOwnPropertyDescriptor(window, 'RankSystem');
    if (!descriptor || descriptor.configurable) {
        let value = window.RankSystem;
        Object.defineProperty(window, 'RankSystem', {
            configurable: true,
            enumerable: true,
            get() { return value; },
            set(next) { value = next; patchClass(next); }
        });
        patchClass(value);
    } else { patchClass(window.RankSystem); }

    document.addEventListener('DOMContentLoaded', mountToolbar, { once: true });
    if (document.readyState !== 'loading') mountToolbar();
    const tick = setInterval(() => {
        mountToolbar();
        const rs = state.instance;
        if (enabled && rs?.data && installed.has(rs) && rs._ccpcUserFreezePhase !== showAll(rs)) {
            rs.ProcessData();
            rs.RecreateHeaderRow();
            rs.UpdateRank();
        }
        updateStatus();
        syncReplayControls();
        if (enabled && !rs && document.querySelector('#rank-grid > [data-row-id]')) {
            const el = document.getElementById('ccpc-new-board-status');
            if (el) el.textContent = '脚本加载较晚，请刷新页面以启用新模式';
        }
    }, 1000);
    window.addEventListener('pagehide', () => clearInterval(tick), { once: true });
})();
