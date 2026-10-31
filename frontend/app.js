const API = (window.API_BASE_URL || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
let selectedNumber = null;
let pollHandle = null;
let adminToken = sessionStorage.getItem('nmg_admin_token') || '';
let playerToken = localStorage.getItem('nmg_player_token') || '';
let playerData = null;

function toast(message) { const el=$('toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove('show'),3200); }
function showPage(id) { document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===id)); document.querySelectorAll('.nav-link').forEach(b=>b.classList.toggle('active',b.dataset.page===id)); window.scrollTo({top:0,behavior:'smooth'}); }
function esc(v='') { return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function api(path, options={}) {
  const headers={'Content-Type':'application/json',...(options.headers||{})};
  if(options.auth==='player') headers.Authorization=`Bearer ${playerToken}`;
  if(options.auth==='admin') headers.Authorization=`Bearer ${adminToken}`;
  const response=await fetch(`${API}${path}`,{...options,headers});
  const data=await response.json().catch(()=>({error:'The server returned an invalid response.'}));
  if(!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

document.querySelectorAll('[data-page]').forEach(el=>el.addEventListener('click',()=>showPage(el.dataset.page)));
$('register-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const payload={playerId:$('player-id').value.trim(),fullName:$('full-name').value.trim(),telegramUsername:$('telegram').value.trim(),group:document.querySelector('input[name="group"]:checked').value};
  try { const data=await api('/api/register',{method:'POST',body:JSON.stringify(payload)}); playerToken=data.token;localStorage.setItem('nmg_player_token',playerToken);playerData=data.player;toast('Registration successful. Welcome to the game!');await enterPlayer(); }
  catch(err){toast(err.message);}
});
$('admin-login-form').addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/admin/login',{method:'POST',body:JSON.stringify({username:$('admin-user').value.trim(),password:$('admin-pass').value})});adminToken=d.token;sessionStorage.setItem('nmg_admin_token',adminToken);$('admin-pass').value='';await enterAdmin();}catch(err){toast(err.message);}});

async function enterPlayer(){try{const d=await api('/api/me',{auth:'player'});playerData=d.player;showPage('player');renderPlayer(d);startPolling();}catch(err){playerToken='';localStorage.removeItem('nmg_player_token');toast('Your player session is not valid. Please register again.');showPage('register');}}
async function enterAdmin(){try{await loadAdmin();showPage('admin');startPolling();}catch(err){adminToken='';sessionStorage.removeItem('nmg_admin_token');toast(err.message);showPage('admin-login');}}
function renderPlayer(data){
  const p=data.player; const status=data.status; $('welcome-name').textContent=p.fullName; $('welcome-group').textContent=`Group ${p.group}`;
  $('selection-state').textContent=p.hasSelected?'Number submitted ✓':'Not submitted';
  $('selection-note').textContent=p.hasSelected?'Your number is saved privately.': 'Your number is private from all other players.';
  $('confirm-number').disabled=selectedNumber===null||p.hasSelected||status.state!=='waiting';
  $('confirm-number').textContent=p.hasSelected?'Number submitted':'Confirm my number';
  $('progress-text').textContent=`Group A: ${status.counts.A}/5 · Group B: ${status.counts.B}/5 · Numbers submitted: ${status.selected}/10`;
  $('progress-bar').style.width=`${status.total/10*100}%`;
  $('player-timer').textContent=status.state==='countdown'?`${status.secondsRemaining}s`:status.state==='published'?'Complete':'Waiting';
  const grid=$('number-grid');grid.innerHTML='';
  for(let n=1;n<=10;n++){const b=document.createElement('button');b.className='number-btn';b.type='button';b.textContent=n;b.disabled=p.hasSelected||status.state!=='waiting';if(selectedNumber===n)b.classList.add('selected');b.addEventListener('click',()=>{selectedNumber=n;renderPlayer(data);});grid.appendChild(b);}
  const result=$('player-result');
  if(data.result){result.hidden=false;const r=data.result;
    if(!r.partner){result.innerHTML=`<div class="trophy">💫</div><p class="eyebrow">ROUND COMPLETE</p><h2>Good try, ${esc(p.fullName)}!</h2><p>No matching partner was found this round. Thank you for playing.</p><p class="hint">Your selection remains private from other players.</p><button class="btn green" id="continue-playing" type="button">Continue Playing</button>`;}
    else {const partner=r.partner;const tg=String(partner.telegramUsername||'').replace(/^@/,'');const link=/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(tg)?`<a class="telegram-link" href="https://t.me/${encodeURIComponent(tg)}" target="_blank" rel="noopener noreferrer">✈ Message on Telegram</a>`:'';
      result.innerHTML=`<div class="trophy">🏆</div><p class="eyebrow">A PERFECT MATCH!</p><h2>Congratulations!</h2><p>You’ve found your match!</p><div class="partner-card"><span>Your match partner is:</span><strong>${esc(partner.fullName)}</strong><span>${esc(partner.telegramUsername)}</span>${link}</div><div class="bond-prompt"><div>🤝 ❤️</div><h3>Build your relationship as sister and brother</h3><p>Start with kindness and respect. Get to know each other, encourage one another, and build a friendly bond like a sister and brother.</p><b>Respect · Kindness · Friendship</b></div><p class="hint">This pair information is visible only to you and your matched partner.</p><button class="btn green" id="continue-playing" type="button">Continue Playing</button>`;
    }
  } else result.hidden=true;
}
$('confirm-number').addEventListener('click',async()=>{if(selectedNumber===null)return;try{await api('/api/select',{method:'POST',auth:'player',body:JSON.stringify({number:selectedNumber})});selectedNumber=null;toast('Your number was submitted privately.');await refreshPlayer();}catch(err){toast(err.message);}});
async function refreshPlayer(){const d=await api('/api/me',{auth:'player'});renderPlayer(d);}
document.addEventListener('click',e=>{if(e.target && e.target.id==='continue-playing')toast('The next round opens after the administrator resets the game. You can then register again.');});
async function loadAdmin(){const d=await api('/api/admin/dashboard',{auth:'admin'});$('admin-total').textContent=`${d.status.total}/10`;$('admin-a').textContent=`${d.status.counts.A}/5`;$('admin-b').textContent=`${d.status.counts.B}/5`;$('admin-status').textContent=d.status.state==='waiting'?'Registration / selection':d.status.state==='countdown'?`${d.status.secondsRemaining}s countdown`:'Results published';$('admin-rows').innerHTML=d.players.length?d.players.map(p=>`<tr><td>${esc(p.fullName)}</td><td>${esc(p.playerId)}</td><td>${esc(p.telegramUsername)}</td><td>Group ${p.group}</td><td>${p.number??'—'}</td><td>${p.number===null?'Waiting':'Submitted'}</td></tr>`).join(''):'<tr><td colspan="6">No players yet.</td></tr>';}
$('admin-refresh').addEventListener('click',()=>loadAdmin().then(()=>toast('Dashboard updated.')).catch(e=>toast(e.message)));
$('reset-game').addEventListener('click',async()=>{if(!confirm('Reset this round? All current players and selections will be deleted.'))return;try{await api('/api/admin/reset',{method:'POST',auth:'admin'});await loadAdmin();toast('A new round is ready.');}catch(err){toast(err.message);}});
function stopPolling(){if(pollHandle)clearInterval(pollHandle);pollHandle=null;}
function startPolling(){stopPolling();pollHandle=setInterval(async()=>{try{if(document.querySelector('#player.page.active')&&playerToken)await refreshPlayer();if(document.querySelector('#admin.page.active')&&adminToken)await loadAdmin();}catch(e){console.warn(e.message);}},2500);}
$('player-logout').addEventListener('click',()=>{playerToken='';playerData=null;localStorage.removeItem('nmg_player_token');selectedNumber=null;stopPolling();showPage('home');toast('You have logged out on this device.');});
$('admin-logout').addEventListener('click',()=>{adminToken='';sessionStorage.removeItem('nmg_admin_token');stopPolling();showPage('home');});
(async()=>{if(playerToken)await enterPlayer();else if(adminToken)await enterAdmin();else{try{await api('/api/status');}catch(e){toast('Cannot reach the backend. Check config.js and the backend URL.');}}})();
