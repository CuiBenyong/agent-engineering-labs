// 审核台页面：一个手写的单文件 HTML，直接以字符串形式发出去。
// 页面里刻意不用任何框架与打包器——这一天的重点是接口与数据形状，不是前端工程。

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>审片室</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; font: 14px/1.6 system-ui, sans-serif; background: #f6f7f9; color: #16181d }
  header { padding: 16px 24px; background: #16181d; color: #fff }
  header b { font-size: 16px }
  header span { opacity: .7; margin-left: 12px; font-size: 12px }
  main { padding: 20px; display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)) }
  .card { background: #fff; border: 1px solid #e3e5ea; border-radius: 10px; padding: 14px }
  .card h3 { margin: 0 0 8px; font-size: 15px }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 8px }
  img, video { width: 100%; border-radius: 6px; background: #000; display: block }
  audio { width: 100%; margin-top: 8px }
  textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; border: 1px solid #d4d7dd; border-radius: 6px }
  button { font: inherit; padding: 5px 10px; border: 1px solid #d4d7dd; background: #fff; border-radius: 6px; cursor: pointer }
  button.primary { background: #16181d; color: #fff; border-color: #16181d }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px }
  .affected { font-size: 12px; color: #9a3412; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 6px; margin-top: 8px }
  .versions { font-size: 12px; margin-top: 10px; border-top: 1px dashed #e3e5ea; padding-top: 8px }
  .versions div { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0 }
  .cur { font-weight: 700 }
  .gen { color: #b45309 }
</style>
</head>
<body>
<header><b>审片室</b><span id="runid"></span><span id="tip">改台词只登记草稿，点重生成才会真的花钱</span></header>
<main id="grid"></main>
<script>
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined).then(r => r.json())

function versionRow(shot, v) {
  const d = document.createElement('div')
  const left = document.createElement('span')
  left.textContent = 'v' + v.version + ' · ' + v.reason + ' · 重跑 ' + v.regenerated.length + ' 个节点'
  if (v.version === shot.current) left.className = 'cur'
  const btn = document.createElement('button')
  btn.textContent = v.version === shot.current ? '当前' : '回滚到这版'
  btn.disabled = v.version === shot.current
  btn.onclick = () => api('/api/shots/' + shot.id + '/rollback', { version: v.version }).then(render)
  d.append(left, btn)
  return d
}

function card(shot) {
  const el = document.createElement('section')
  el.className = 'card'
  const h = document.createElement('h3')
  h.textContent = shot.id + ' · ' + shot.shotSize + ' · ' + shot.durationSec + ' 秒'
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = shot.camera + ' · 当前 v' + shot.current
  if (shot.status === 'generating') { meta.textContent += ' · 生成中'; meta.classList.add('gen') }

  const img = document.createElement('img')
  img.src = shot.media.frame + '?v=' + shot.current
  img.alt = shot.id + ' 首帧'
  const video = document.createElement('video')
  video.src = shot.media.clip + '?v=' + shot.current
  video.controls = true
  const audio = document.createElement('audio')
  audio.src = shot.media.voice + '?v=' + shot.current
  audio.controls = true

  const ta = document.createElement('textarea')
  ta.rows = 2
  ta.value = shot.dialogue
  const row = document.createElement('div')
  row.className = 'row'
  const calc = document.createElement('button')
  calc.textContent = '算影响范围'
  const regen = document.createElement('button')
  regen.textContent = '重生成受影响节点'
  regen.className = 'primary'
  regen.disabled = !shot.pending
  const box = document.createElement('div')
  if (shot.pending) {
    box.className = 'affected'
    box.textContent = '待生效：' + shot.pending.field + ' → ' + shot.pending.value + '；波及 ' + shot.pending.affected.join('、')
  }
  calc.onclick = () => api('/api/shots/' + shot.id + '/edit', { field: 'dialogue', value: ta.value }).then(render)
  regen.onclick = () => { regen.disabled = true; regen.textContent = '生成中…'; api('/api/shots/' + shot.id + '/regenerate', {}).then(render) }

  const pass = document.createElement('button')
  pass.textContent = '通过'
  pass.onclick = () => api('/api/shots/' + shot.id + '/review', { verdict: 'pass', tags: ['ok'], comment: '' }).then(render)
  const redo = document.createElement('button')
  redo.textContent = '打回'
  redo.onclick = () => api('/api/shots/' + shot.id + '/review', { verdict: 'redo', tags: ['face-inconsistent'], comment: '角色脸不一致' }).then(render)
  row.append(calc, regen, pass, redo)

  const versions = document.createElement('div')
  versions.className = 'versions'
  shot.versions.forEach(v => versions.append(versionRow(shot, v)))

  el.append(h, meta, img, video, audio, ta, row, box, versions)
  return el
}

function render(state) {
  const go = state && state.shots ? Promise.resolve(state) : api('/api/run')
  return go.then(s => {
    document.getElementById('runid').textContent = s.runId
    const grid = document.getElementById('grid')
    grid.textContent = ''
    s.shots.forEach(shot => grid.append(card(shot)))
  })
}
render()
</script>
</body>
</html>`
