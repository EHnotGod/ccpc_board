'use strict';

// Optional browser integration checks. Use an installed Chrome and Playwright:
//   npm install --no-save playwright
//   node tests/browser-smoke.cjs
// CCPC_PLAYWRIGHT_MODULE may point to an existing playwright/playwright-core package.
// CCPC_BROWSER_CHANNEL defaults to chrome; CCPC_BROWSER_EXECUTABLE overrides it.
// Screenshots are written outside the repository unless CCPC_SMOKE_OUTPUT is set.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chromium } = require(process.env.CCPC_PLAYWRIGHT_MODULE || 'playwright');
const URL = process.env.CCPC_SMOKE_URL
    || 'https://rank.iccpc.cn/r/8884583c-c577-4379-90c5-783f103ad910';
const SCRIPT = path.resolve(__dirname, '..', 'ccpc-new-board.user.js');
const OUTPUT = process.env.CCPC_SMOKE_OUTPUT
    || fs.mkdtempSync(path.join(os.tmpdir(), 'ccpc-board-smoke-'));
const PROBLEMS = { A: 91001, B: 91002, C: 91003, D: 91004 };

function fixture() {
    const teams = Array.from({ length: 6 }, (_, index) => ({
        contest_id: 1003,
        team_id: `T${index + 1}`,
        name: `测试队 ${index + 1}`,
        name_en: `Fixture team ${index + 1}`,
        coach: '',
        tmember: '',
        school: `测试学校 ${index + 1}`,
        region: '',
        tkind: index === 5 ? 1 : 0,
        room: '',
        privilege: '',
        group_ids: ['default'],
    }));
    teams.push({ ...teams[0], team_id: 'STAR', name: '打星测试队', tkind: 2 });
    const solution = (id, team, problem, time, result) => ({
        solution_id: id,
        contest_id: 1003,
        problem_id: PROBLEMS[problem],
        team_id: team,
        result,
        in_date: `2026-10-01 ${time}`,
        language: 'C++',
    });
    return {
        contest: {
            contest_id: 1003,
            title: '浏览器集成测试 · 五小时比赛',
            start_time: '2026-10-01 10:00:00',
            end_time: '2026-10-01 15:00:00',
            frozen_minute: 0,
            frozen_after: 0,
            private: 3,
            defunct: '1',
            topteam: 1,
            award_ratio: 30020010,
            flg_award_qty_mode: 0,
            flg_award_base: 1,
            flg_balloon_shuffle: 1,
        },
        ccpc_meta: {
            view: 'referee',
            n_teams: 7,
            threshold: 50,
            frozen_show_all: true,
            n_problems: 4,
        },
        time_context: {
            schema_version: 1,
            wall_clock_timezone: 'Asia/Shanghai',
            encoding: 'naive_app_wall',
        },
        contest_group: [{ group_id: 'default', group_name: '测试赛事', group_name_en: 'Fixture' }],
        group_count: 1,
        is_multi_group: 0,
        team: teams,
        problem: Object.entries(PROBLEMS).map(([letter, problem_id], num) => ({
            problem_id,
            title: `Fixture ${letter}`,
            num,
            color: '#ff0000',
            // Deliberately bogus final totals: a replay header must ignore these.
            accepted: 999,
            submit: 9999,
            pscore: 25,
        })),
        solution: [
            solution(1, 'T1', 'A', '10:10:00', 4),
            solution(2, 'STAR', 'A', '10:20:00', 4),
            solution(3, 'T1', 'B', '11:00:00', 4),
            solution(4, 'T2', 'C', '12:00:00', 11),
            solution(5, 'T3', 'D', '13:59:00', 6),
            solution(6, 'T3', 'D', '14:05:00', 4),
        ],
    };
}

function monitor(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    return errors;
}

async function ready(page) {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
        const state = window.CCPCNewBoard;
        return state?.enabled && state.instance?.data && state.instance.rankList?.length;
    }, null, { timeout: 30000 });
    await page.waitForSelector('#rank-grid .rank-row', { timeout: 30000 });
}

async function replay(page, seconds) {
    // Exercise the same replay entry point used by the site's slider.
    await page.evaluate(seconds => {
        const rank = window.CCPCNewBoard.instance;
        const duration = (rank.contestEndTime - rank.contestStartTime) / 1000;
        rank.SetReplayTime(100 * seconds / duration);
        rank.timeReplayMode = true;
        rank.ApplyTimeReplay();
    }, seconds);
    // ApplyTimeReplay schedules its calculation in an animation frame, followed
    // by the site's serialized renderer. Wait for both, without arbitrary sleeps.
    await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await window.CCPCNewBoard.instance._rankRenderChain;
    });
    await page.waitForFunction(seconds => {
        const rank = window.CCPCNewBoard.instance;
        return Math.abs((rank.replayTime - rank.contestStartTime) / 1000 - seconds) < 0.01;
    }, seconds);
}

async function snapshot(page) {
    return page.evaluate(() => {
        const rank = window.CCPCNewBoard.instance;
        rank.EnsureCcpcReveal();
        const historyKeys = [];
        const cells = [...document.querySelectorAll('#rank-grid .ccpc-private-zone .problem-item')];
        for (const cell of cells) {
            for (const entry of JSON.parse(cell.getAttribute('data-rank-solution-history') || '[]')) {
                historyKeys.push(...Object.keys(entry));
            }
        }
        const rows = {};
        for (const row of rank.rankList) {
            const item = document.querySelector(`#rank-grid [data-row-id="${CSS.escape(String(row.team_id))}"]`);
            rows[row.team_id] = {
                solved: row.solved,
                penalty: row.penalty,
                order: rank.GetProblemColumnOrder(row.problemStats, row),
                stats: row.problemStats,
                renderedPrivateCells: item?.querySelectorAll('.ccpc-private-zone .problem-item').length ?? null,
                renderedPublicCells: item?.querySelectorAll('.ccpc-public-zone .problem-item').length ?? null,
            };
        }
        const headers = [...document.querySelectorAll('#rank-container .rank-header-row .problem-header-content')]
            .map(header => ({
                letter: header.querySelector('.problem-header-title')?.textContent.trim(),
                acTeams: Number(header.getAttribute('data-rank-ac-teams')),
                acSubmissions: Number(header.getAttribute('data-rank-ac-subs')),
                submissions: Number(header.getAttribute('data-rank-subs')),
            }));
        return {
            threshold: rank._ccpcRevealThreshold,
            revealed: rank.GetProblemHeaderList().map(p => rank.GetProblemAlphabetIdx(p.num)),
            headerFinalCountFields: rank.GetProblemHeaderList().flatMap(p =>
                ['accepted', 'submit', 'frozen_submit'].filter(key => Object.hasOwn(p, key))),
            privateCellCount: cells.length,
            hiddenLetters: cells.map(cell => cell.getAttribute('d-pro-idx')).filter(Boolean),
            hiddenFirstBlood: cells.filter(cell => /pro-first-blood/.test(cell.className)).length,
            hiddenHistoryKeys: [...new Set(historyKeys)],
            headers,
            rows,
        };
    });
}

function assertAnonymous(snapshot, message) {
    assert.deepEqual(snapshot.hiddenLetters, [], `${message}: anonymous cells must not contain problem letters`);
    assert.equal(snapshot.hiddenFirstBlood, 0, `${message}: anonymous cells must not contain first-blood flags`);
    for (const key of snapshot.hiddenHistoryKeys) {
        assert.ok(['in_date', 'result', 'language'].includes(key), `${message}: anonymous history leaked ${key}`);
    }
}

async function screenshot(page, name) {
    await page.screenshot({ path: path.join(OUTPUT, name), fullPage: false });
}

async function realContest(browser) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript({ path: SCRIPT });
    const page = await context.newPage();
    const errors = monitor(page);
    await ready(page);
    const duration = await page.evaluate(() => {
        const rank = window.CCPCNewBoard.instance;
        return (rank.contestEndTime - rank.contestStartTime) / 1000;
    });
    const counts = [];
    for (const progress of [10, 20, 50]) {
        await replay(page, duration * progress / 100);
        const state = await snapshot(page);
        assertAnonymous(state, `real contest replay ${progress}%`);
        assert.equal(state.threshold, 50, 'the provided contest has 300 official teams and threshold 50');
        assert.ok(Object.keys(state.rows).length >= 300, 'the existing team standings must remain available');
        counts.push(state.revealed.length);
        if (progress === 10) {
            assert.ok(state.privateCellCount > 0, 'early replay must exercise anonymous cells');
            assert.ok(state.revealed.length < 4, 'early replay must not show the referee snapshot as all-public');
        }
        console.log(`PASS real replay ${progress}%: public [${state.revealed.join(',')}], anonymous cells ${state.privateCellCount}`);
        await screenshot(page, `real-replay-${progress}.png`);
    }
    assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]), 'disclosure must advance with replay time');
    assert.deepEqual(errors, [], 'the real page must have no uncaught browser errors');
    await context.close();
}

async function syntheticContest(browser) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const payload = fixture();
    let requests = 0;
    await context.route('**/upload/outrank_attach/**/rank.json*', async route => {
        requests++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await context.addInitScript({ path: SCRIPT });
    const page = await context.newPage();
    const errors = monitor(page);
    await ready(page);
    assert.ok(requests > 0, 'the fixture must replace a real rank.json request');

    await replay(page, 3 * 3600 + 59 * 60);
    const before = await snapshot(page);
    assert.equal(before.threshold, 2, 'six official teams require two AC teams');
    assert.deepEqual(before.revealed, ['A'], 'the starred team AC must help disclose A, while B stays anonymous');
    assertAnonymous(before, 'fixture before four hours');
    assert.equal(before.rows.T1.solved, 2);
    assert.equal(before.rows.T1.penalty, 70 * 60);
    assert.equal(before.rows.T1.renderedPrivateCells, 1, 'the one-AC B must have an anonymous cell');
    assert.equal(before.rows.T2.stats[PROBLEMS.C].status, 'wa', 'CE-only C must be represented as an attempted problem');
    assert.equal(before.rows.T2.stats[PROBLEMS.C].submitCount, 1);
    assert.equal(before.rows.T2.renderedPrivateCells, 1, 'a CE-only problem must appear in the anonymous zone');
    assert.equal(before.rows.T3.stats[PROBLEMS.D].status, 'wa');
    assert.equal(before.rows.T3.solved, 0);
    assert.equal(before.rows.T3.penalty, 0);
    assert.equal(before.rows.T3.stats[PROBLEMS.D].submitCount, 1, 'future submissions must not enter a replay');
    assert.deepEqual(before.headers.map(header => header.letter), ['A']);
    assert.equal(before.headers[0].acTeams, 2);
    assert.equal(before.headers[0].acSubmissions, 2, 'header popovers must ignore problem.accepted=999');
    assert.deepEqual(before.headerFinalCountFields, [], 'header data shared with the plain layout must omit final totals');
    await screenshot(page, 'fixture-before-four-hours.png');

    await replay(page, 4 * 3600 + 6 * 60);
    const frozen = await snapshot(page);
    assert.deepEqual(frozen.revealed, ['A', 'B', 'C', 'D'], 'all letters must be shown after four hours');
    assert.equal(frozen.privateCellCount, 0, 'the anonymous zone must close when all letters are public');
    for (const row of Object.values(frozen.rows)) {
        assert.equal(row.renderedPublicCells, 4, 'every team must have all four fixed columns after four hours');
    }
    assert.equal(frozen.rows.T3.stats[PROBLEMS.D].status, 'pending', 'a post-freeze AC must stay yellow');
    assert.equal(frozen.rows.T3.stats[PROBLEMS.D].submitCount, 2);
    assert.equal(frozen.rows.T3.solved, 0, 'the frozen AC must not increase solved count');
    assert.equal(frozen.rows.T3.penalty, 0, 'the frozen AC must not increase penalty');
    assert.equal(frozen.rows.T1.solved, before.rows.T1.solved);
    assert.equal(frozen.rows.T1.penalty, before.rows.T1.penalty);
    const dHeader = frozen.headers.find(header => header.letter === 'D');
    assert.ok(dHeader, 'D must have a public header after four hours');
    assert.equal(dHeader.acTeams, 0, 'header team statistics must not expose the frozen AC');
    assert.equal(dHeader.acSubmissions, 0, 'header submission statistics must not expose the frozen AC');
    assert.equal(dHeader.submissions, 2);
    assert.deepEqual(frozen.headerFinalCountFields, [], 'all public header objects must omit final totals after four hours');

    const details = await page.evaluate(({ D }) => {
        const rank = window.CCPCNewBoard.instance;
        const team = document.querySelector('#rank-grid [data-row-id="T3"]');
        const cell = team.querySelector('.problem-item[d-pro-idx="D"]');
        const history = JSON.parse(cell.getAttribute('data-rank-solution-history'));
        const popover = window.RankProblemStatusPopoverContent(cell);
        const holder = document.createElement('div');
        holder.innerHTML = popover.html;
        const summary = document.createElement('div');
        summary.innerHTML = rank.GenerateSummaryHtml();
        const headers = [...summary.querySelectorAll('thead th')].map(th => th.textContent.trim());
        const dIndex = headers.indexOf('D');
        const acRow = [...summary.querySelectorAll('tbody tr')].find(tr => tr.firstElementChild.textContent === 'AC');
        return {
            history,
            popoverVerdicts: [...holder.querySelectorAll('.rank-problem-history-verdict-cn')].map(el => el.textContent),
            statsAc: rank.CalculateSubmissionResultStats()[D].ac,
            summaryDac: Number(acRow.children[dIndex].textContent),
            classes: cell.className,
        };
    }, PROBLEMS);
    assert.deepEqual(details.history.map(entry => entry.result), [6, -1], 'the DOM popover history must mask the post-freeze AC result');
    assert.equal(details.popoverVerdicts.length, 2);
    assert.ok(details.popoverVerdicts.some(verdict => verdict.includes('等待') || verdict.includes('封榜')));
    assert.ok(details.popoverVerdicts.every(verdict => !verdict.includes('正确')), 'the popover must not show the frozen Accepted verdict');
    assert.equal(details.statsAc, 0, 'submission-result statistics must not leak the frozen AC');
    assert.equal(details.summaryDac, 0, 'the summary table must not leak the frozen AC');
    assert.ok(!details.classes.includes('pro-first-blood'), 'the frozen AC must not receive a first-blood marker');
    await screenshot(page, 'fixture-frozen.png');

    await replay(page, 3 * 3600 + 59 * 60);
    const reverted = await snapshot(page);
    assert.deepEqual(reverted.revealed, ['A'], 'replaying an earlier time must restore anonymous columns');
    assertAnonymous(reverted, 'fixture replay restored');
    assert.equal(reverted.rows.T3.stats[PROBLEMS.D].status, 'wa');
    assert.equal(reverted.rows.T3.stats[PROBLEMS.D].submitCount, 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await screenshot(page, 'fixture-mobile-390.png');
    const mobile = await snapshot(page);
    assertAnonymous(mobile, 'mobile fixture');
    assert.equal(mobile.rows.T2.renderedPrivateCells, 1, 'mobile must preserve the CE-only anonymous cell');

    // Public snapshots may omit every problem definition and use an opaque key
    // for each team's anonymous submission. Those cells must still be rendered.
    const projection = fixture();
    projection.problem = [];
    projection.team = [projection.team[0]];
    projection.ccpc_meta = { ...projection.ccpc_meta, view: 'public', n_teams: 1, frozen_show_all: false };
    projection.solution = [{
        solution_id: 20,
        contest_id: 1003,
        problem_id: 'opaque-T1-problem-key',
        team_id: 'T1',
        result: 6,
        in_date: '2026-10-01 10:30:00',
        language: 'C++',
    }];
    await page.evaluate(async projection => {
        const rank = window.CCPCNewBoard.instance;
        rank.OriInit(projection);
        await rank._rankRenderChain;
    }, projection);
    const publicProjection = await snapshot(page);
    assert.deepEqual(publicProjection.revealed, [], 'an opaque public snapshot must have no disclosed letters');
    assert.equal(publicProjection.privateCellCount, 1, 'an empty problem list must not remove an anonymous submitted problem');
    assert.equal(publicProjection.rows.T1.renderedPrivateCells, 1);
    assertAnonymous(publicProjection, 'opaque public projection');
    const projectionSummary = await page.evaluate(() => {
        const rank = window.CCPCNewBoard.instance;
        return {
            total: rank.GetProblemTotal(),
            wa: rank.CalculateSubmissionResultStats()['opaque-T1-problem-key'].wa,
            anonymousHeader: document.querySelector('.ccpc-private-zone-head')?.textContent,
            summary: rank.GenerateSummaryHtml(),
        };
    });
    assert.equal(projectionSummary.total, 4, 'total problem count must come from public projection metadata');
    assert.equal(projectionSummary.wa, 1, 'summary statistics must include opaque anonymous problem keys');
    assert.ok(projectionSummary.anonymousHeader?.includes('未公开题目'));
    assert.ok(projectionSummary.summary.includes('未公开题目合计'));
    assert.deepEqual(errors, [], 'desktop and mobile fixture must have no uncaught browser errors');
    console.log('PASS fixture: six official teams, starred disclosure, CE-only cell, four-hour freeze, masked popover/statistics, reverse replay, 390px mobile, opaque public projection');
    await context.close();
}

(async () => {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const executablePath = process.env.CCPC_BROWSER_EXECUTABLE;
    const options = { headless: true };
    if (executablePath) options.executablePath = executablePath;
    else options.channel = process.env.CCPC_BROWSER_CHANNEL || 'chrome';
    const browser = await chromium.launch(options);
    try {
        await realContest(browser);
        await syntheticContest(browser);
        console.log(`PASS browser smoke; screenshots: ${OUTPUT}`);
    } finally {
        await browser.close();
    }
})().catch(error => {
    console.error(error);
    console.error(`Browser smoke artifacts: ${OUTPUT}`);
    process.exitCode = 1;
});
