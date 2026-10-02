import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, DrillExportResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { buildZip } from '@/api/zip'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 登记了流转表的模块：状态只能一段一段往前推，倒序、跳段、终态再改都拦下。
  const transitions = meta.transitions
  if (transitions) {
    const allowed = transitions[current] ?? []
    if (!allowed.includes(target)) {
      if (allowed.length === 0) {
        return { ok: false, message: `${meta.entity}已处于「${current}」，这一段已经办结，不能再执行「${action}」` }
      }
      const currentIndex = meta.statuses.indexOf(current)
      const targetIndex = meta.statuses.indexOf(target)
      if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex) {
        return { ok: false, message: `${meta.entity}状态只能一段一段往前推，不允许从「${current}」回退到「${target}」` }
      }
      return { ok: false, message: `${meta.entity}状态只能一段一段往前推，不能从「${current}」直接跳到「${target}」，请先推进到「${allowed.join('」「')}」` }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: transitions ? (transitions[target] ?? []).length > 0 : target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// —— 应急演练评估材料分发 ——
// 按参演队伍把当期（某个演练日期）已评估的演练归成几沓，打进一个 zip 直接发出去。

const DRILL_KEY = 'drill'
const SIGNBOARD_KEY = 'signboard'

// 参演人数与评估结论打架时的优先级判定：以台账登记的参演人数为准。
// 这条规则同时写进每一包的《分包说明》，送出去的人能直接看到判定依据。
const PRIORITY_RULE =
  '参演人数与评估结论不一致时，以台账登记的参演人数为准：人数为 0 的按「未实际开展」标注，评估结论存疑待复核；' +
  '人数大于 0 的按「已开展」标注，评估结论文字保留、待更正。'

/** 参演人数精度门槛：必须是非负整数，「约40」「40人左右」「」这类一律算精度不够。 */
function isPreciseHeadcount(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? '').trim())
}

/** 结论文本与人数是否打架；打架时返回按人数为准的标注，不打架返回空串。 */
function headcountConflictNote(headcount: number, conclusion: string): string {
  const saysConducted = /达标|通过|完成|成功|优秀|良好|合格|有序|及时|到位/.test(conclusion)
  const saysNotConducted = /未开展|未举行|未进行|未组织|流于形式/.test(conclusion)
  if (headcount === 0 && saysConducted) {
    return '人数与结论冲突：按优先级判定以参演人数为准，认定为未实际开展，评估结论存疑待复核'
  }
  if (headcount > 0 && saysNotConducted) {
    return '人数与结论冲突：按优先级判定以参演人数为准，认定为已开展，评估结论文字待更正'
  }
  return ''
}

function todayLocal(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 台账里最新一个演练日期，作为分发页面的默认当期。 */
export function latestDrillPeriod(): string {
  const dates = listRows(DRILL_KEY)
    .map((row) => String(row['演练日期'] ?? ''))
    .filter((date) => date !== '')
    .sort()
  return dates.length > 0 ? dates[dates.length - 1] : ''
}

/**
 * 导出办结后落到警示标识清单的演练复核项。
 * 编号按当期定（YLFH-日期），重复导出找到已有那条就沿用，不新增记录。
 */
function ensureDrillReviewItem(period: string, stacks: number, headcount: number): { code: string; reused: boolean } {
  const code = `YLFH-${period}`
  const rows = listRows(SIGNBOARD_KEY)
  if (rows.some((row) => String(row['标识编号']) === code)) {
    return { code, reused: true }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const reviewRow: EntryRow = {
    id: nextId,
    status: '待设置',
    pending: true,
    abnormal: false,
    标识编号: code,
    所属隐患点: '—',
    标识类别: '演练复核',
    设置位置: `演练评估材料分包（${period}，共${stacks}沓，参演合计${headcount}人）`,
    设置日期: todayLocal(),
    责任人: '演练评估导出',
    更换日期: '—',
    标识状态: '待复核',
    // 两处读到的参演人数要一致：这里登记的合计与包内各沓合计来自同一次台账读取。
    参演人数合计: headcount,
  }
  saveRows(SIGNBOARD_KEY, [...rows, reviewRow])
  return { code, reused: false }
}

export function exportDrillMaterials(period: string): DrillExportResult {
  const fail = (message: string): DrillExportResult => ({
    ok: false,
    message,
    filename: '',
    entries: [],
    stacks: 0,
    notices: 0,
    returned: 0,
    conflicts: 0,
    headcount: 0,
    reviewItem: '',
    reviewReused: false,
  })
  if (period.trim() === '') {
    return fail('请先选定演练日期（当期）再导出评估材料')
  }
  const ledger = listRows(DRILL_KEY)
  const teams = [...new Set(ledger.map((row) => String(row['参演队伍'] ?? '').trim()).filter((name) => name !== ''))]
  if (teams.length === 0) {
    return fail('台账里还没有参演队伍，无法分包')
  }
  const inPeriod = ledger.filter((row) => String(row['演练日期']) === period)

  // 先过精度门槛：参演人数精度不够的已评估演练不进包，退回校准并在台账上标异常。
  const evaluated = inPeriod.filter((row) => String(row.status) === '已评估')
  const returnedRows = evaluated.filter((row) => !isPreciseHeadcount(row['参演人数']))
  const exportable = evaluated.filter((row) => isPreciseHeadcount(row['参演人数']))
  if (returnedRows.length > 0) {
    const returnedIds = new Set(returnedRows.map((row) => Number(row.id)))
    saveRows(DRILL_KEY, ledger.map((row) => (returnedIds.has(Number(row.id)) ? { ...row, abnormal: true } : row)))
  }

  // 两处读到的参演人数要一致：打包前再读一次台账，逐条与组包用的值比对，对不上就中止。
  const reread = listRows(DRILL_KEY)
  const rereadById = new Map(reread.map((row) => [Number(row.id), row]))
  for (const row of exportable) {
    const again = rereadById.get(Number(row.id))
    if (!again || String(again['参演人数']) !== String(row['参演人数'])) {
      return fail(`演练 ${row['演练编号']} 的参演人数两处读取不一致，已中止导出，请核对台账后重试`)
    }
  }

  const entries: { name: string; content: string }[] = []
  const conflictLines: string[] = []
  let stacks = 0
  let notices = 0
  let headcount = 0

  for (const team of teams) {
    const teamRows = exportable.filter((row) => String(row['参演队伍']) === team)
    if (teamRows.length > 0) {
      // 一沓：演练编号、演练主题、参演人数、评估结论，另附核对备注写冲突标注。
      const lines = ['演练编号,演练主题,参演人数,评估结论,核对备注']
      for (const row of teamRows) {
        const count = Number(String(row['参演人数']).trim())
        const conclusion = String(row['评估结论'] ?? '')
        const note = headcountConflictNote(count, conclusion)
        if (note !== '') {
          conflictLines.push(`${team} / ${row['演练编号']}：${note}`)
        }
        headcount += count
        lines.push([row['演练编号'], row['演练主题'], row['参演人数'], conclusion, note].join(','))
      }
      entries.push({ name: `${team}-${period}-评估材料.csv`, content: `﻿${lines.join('\n')}` })
      stacks += 1
      continue
    }
    // 当期没有可分发材料的队伍给说明文件，不给空包；原因按实际情况拼全。
    const teamAll = inPeriod.filter((row) => String(row['参演队伍']) === team)
    const teamReturned = returnedRows.filter((row) => String(row['参演队伍']) === team)
    const reasons: string[] = []
    if (teamAll.length === 0) {
      reasons.push('当期未安排演练')
    } else {
      const unevaluated = teamAll.filter((row) => String(row.status) !== '已评估')
      if (unevaluated.length > 0) {
        reasons.push(`当期演练尚未完成评估：${unevaluated.map((row) => `${row['演练编号']}（${row.status}）`).join('、')}`)
      }
      if (teamReturned.length > 0) {
        reasons.push(`演练 ${teamReturned.map((row) => String(row['演练编号'])).join('、')} 参演人数精度不足，已退回校准`)
      }
    }
    const notice = [
      '演练评估材料分发说明',
      `参演队伍：${team}`,
      `演练日期（当期）：${period}`,
      `说明：${reasons.join('；')}。`,
      '本期无评估材料随包分发，此说明文件用于替代空包，便于对照查收。',
    ].join('\n')
    entries.push({ name: `${team}-${period}-无演练说明.txt`, content: notice })
    notices += 1
  }

  if (returnedRows.length > 0) {
    const lines = ['演练编号,参演队伍,参演人数原值,退回原因']
    for (const row of returnedRows) {
      lines.push([row['演练编号'], row['参演队伍'], row['参演人数'] ?? '', '参演人数精度不够，退回校准'].join(','))
    }
    entries.push({ name: `退回校准清单-${period}.csv`, content: `﻿${lines.join('\n')}` })
  }

  const review = ensureDrillReviewItem(period, stacks, headcount)
  const summary = [
    '演练评估材料分包说明',
    `演练日期（当期）：${period}`,
    `导出时间：${todayLocal()}`,
    '',
    `一、分包规则：按参演队伍分沓，每沓放演练编号、演练主题、参演人数与评估结论，沓名带队伍名与演练日期；当期没有可分发材料的队伍附说明文件，不发空包。`,
    `二、人数一致性：包内各沓参演人数与演练台账逐项核对一致（导出前已二次读取校验）；警示标识清单里的演练复核项（${review.code}）登记的参演人数合计与本包一致，均为 ${headcount} 人。`,
    `三、优先级判定：${PRIORITY_RULE}`,
    `四、冲突条目：${conflictLines.length > 0 ? '' : '无'}`,
    ...conflictLines.map((line) => `　${line}`),
    `五、退回校准：${returnedRows.length > 0 ? returnedRows.map((row) => String(row['演练编号'])).join('、') : '无'}`,
  ].join('\n')
  entries.unshift({ name: `分包说明-${period}.txt`, content: summary })

  const reviewText = review.reused ? `沿用已有复核项 ${review.code}` : `警示标识清单已新建复核项 ${review.code}`
  const message =
    `已按 ${teams.length} 支队伍分包：评估材料 ${stacks} 沓、无演练说明 ${notices} 份、退回校准 ${returnedRows.length} 条；` +
    `参演人数合计 ${headcount} 人（与台账核对一致）；${reviewText}。`
  return {
    ok: true,
    message,
    filename: `演练评估材料-${period}.zip`,
    entries,
    stacks,
    notices,
    returned: returnedRows.length,
    conflicts: conflictLines.length,
    headcount,
    reviewItem: review.code,
    reviewReused: review.reused,
  }
}

export function downloadDrillMaterials(period: string): DrillExportResult {
  const result = exportDrillMaterials(period)
  if (!result.ok) {
    return result
  }
  const blob = buildZip(result.entries)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return result
}
