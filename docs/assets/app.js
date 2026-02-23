'use strict';

const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);
const esc = (s="") => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const isEmail = (s="") => /.+@.+\..+/.test(String(s).trim());

const APP = {
  sb: null,
  session: null,
  me: null,        // profile row
  route: 'home',
  book: { category:null, service:null, budget:200, catPage:0 },
  pendingRequest: null, // {packageId}
  feedMode: 'all',
  profileView: { id:null, tab:'posts' },
  msg: { activeBookingId:null },
};


function parseAddonsWithPricing(lines){
  // Accept formats:
  //  - "BTS reel | 100"
  //  - "Extra revision - 50"
  //  - "Rush delivery 200"
  return (lines||[]).map(s => String(s||'').trim()).filter(Boolean).map(line=>{
    let label=line, price=0;
    if(line.includes('|')){
      const parts=line.split('|').map(x=>x.trim());
      label=parts[0]||label;
      price=Number(parts[1]||0);
    }else if(line.includes(' - ')){
      const parts=line.split(' - ').map(x=>x.trim());
      label=parts[0]||label;
      price=Number(parts[1]||0);
    }else{
      const m=line.match(/^(.*?)(\s+\$?([0-9]+))$/);
      if(m){ label=m[1].trim(); price=Number(m[3]||0); }
    }
    const cents = Math.max(0, Math.round(price*100));
    return { label: label.trim(), price_cents: cents };
  }).filter(a => a.label);
}
function toast(msg){
  const t = byId('toast');
  if(!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> t.style.display='none', 2200);
}

function centsFromUsd(n){
  const x = Number(n || 0);
  return Math.max(0, Math.round(x * 100));
}

function usdFromCents(c){
  return (Number(c||0)/100).toFixed(0);
}

function showPage(name){
  APP.route = name;
  $$('.page').forEach(p => p.classList.toggle('is-on', p.dataset.page === name));
  $$('.navbtn').forEach(b => b.classList.toggle('is-on', b.dataset.nav === name));
  // close menu
  const dd = byId('userMenu');
  if(dd) dd.classList.remove('open');
  renderAuthBits();
  if(name === 'home') loadFeed().catch(()=>{});
  if(name === 'book') renderBook().catch(()=>{});
  if(name === 'projects') loadProjects().catch(()=>{});
  if(name === 'messages'){
    // reset to list view
    const lv = byId('msgListView'); const dv = byId('msgDetailView');
    if(lv) lv.style.display = 'block';
    if(dv) dv.style.display = 'none';
    APP.msg.activeBookingId = null;
    APP.msgTab = APP.msgTab || 'pending';
    byId('msgTabPending')?.classList.toggle('is-on', APP.msgTab==='pending');
    byId('msgTabApproved')?.classList.toggle('is-on', APP.msgTab==='approved');
    byId('msgListTitle') && (byId('msgListTitle').textContent = (APP.msgTab==='pending') ? 'Pending threads' : 'Approved threads');
    loadMessages().catch(()=>{});
  }
  if(name === 'profile') loadProfile().catch(()=>{});
}

function renderAuthBits(){
  const authed = !!APP.session?.user;
  $$('.auth-only').forEach(el => el.style.display = authed ? '' : 'none');
  $$('.guest-only').forEach(el => el.style.display = authed ? 'none' : '');
  const btnSignIn = byId('btnSignIn');
  if(btnSignIn) btnSignIn.style.display = authed ? 'none' : '';
  const menuLabel = byId('menuLabel');
  if(menuLabel) menuLabel.textContent = APP.me?.username ? `@${APP.me.username}` : 'Menu';
}

function openModal(title, html){
  byId('modalTitle').textContent = title || 'Request';
  byId('modalBody').innerHTML = html || '';
  byId('modal').classList.remove('hidden');
}
function closeModal(){
  byId('modal').classList.add('hidden');
}



/* ----------------------------- storage uploads ----------------------------- */
function _safeName(name="file"){
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'') || 'file';
}

async function uploadToStorage(bucket, folder, file){
  if(!file) return null;
  if(!APP.sb?.storage){
    throw new Error('Storage not available');
  }
  const uid = APP.session?.user?.id || 'anon';
  const stamp = Date.now();
  const path = `${folder}/${uid}/${stamp}_${_safeName(file.name)}`;
  const up = await APP.sb.storage.from(bucket).upload(path, file, { upsert: true, contentType: file.type || undefined });
  if(up.error) throw up.error;
  const pub = APP.sb.storage.from(bucket).getPublicUrl(path);
  const url = pub?.data?.publicUrl || null;
  if(!url) throw new Error('Could not get public URL');
  return url;
}

function storageSetupHint(){
  return 'Storage not set up. In Supabase: Storage → create PUBLIC bucket named "creatorhub".';
}

async function init(){
  // Basic config check
  if(!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || window.SUPABASE_URL.includes('PASTE_')){
    toast('Set SUPABASE_URL and SUPABASE_ANON_KEY in assets/config.js');
  }

  APP.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  wireUI();

  // Restore session BEFORE rendering protected screens
  const { data } = await APP.sb.auth.getSession();
  APP.session = data.session || null;
  await hydrateProfile();

  APP.sb.auth.onAuthStateChange(async (_event, session) => {
    APP.session = session || null;
    await hydrateProfile();
    renderAuthBits();

    // If we were waiting to request a package, open it now.
    if(APP.session?.user && APP.pendingRequest?.packageId){
      const pid = APP.pendingRequest.packageId;
      APP.pendingRequest = null;
      await openRequestForPackage(pid);
    }
    // If on signin page, bounce home
    if(APP.session?.user && APP.route === 'signin') showPage('home');
  });

  // initial route
  showPage('home');
}

function wireUI(){
  // nav
  document.addEventListener('click', (e) => {
    const t = e.target;

    const navEl = t.closest?.('[data-nav]');
    const nav = navEl?.dataset?.nav;
    if(nav){
      e.preventDefault();
      const gated = ['book','create','projects','profile','messages'];
      if(gated.includes(nav) && !APP.session?.user){
        toast('Sign in to continue');
        showPage('signin');
        return;
      }
      showPage(nav);
      return;
    }

    const feedEl = t.closest?.('[data-feed]');
    const feedMode = feedEl?.dataset?.feed;
    if(feedMode){
      APP.feedMode = feedMode;
      $$('.segbtn').forEach(b => b.classList.toggle('is-on', b.dataset.feed === feedMode));
      loadFeed().catch(()=>{});
      return;
    }

    const tabEl = t.closest?.('[data-profiletab]');
    const tab = tabEl?.dataset?.profiletab;
    if(tab){
      setProfileTab(tab);
      return;
    }

    const catEl = t.closest?.('[data-cat]');
    const cat = catEl?.dataset?.cat;
    if(cat){
      APP.book.category = cat;
      APP.book.service = null;
      renderBook().catch(()=>{});
      return;
    }

    const svcEl = t.closest?.('[data-svc]');
    const svc = svcEl?.dataset?.svc;
    if(svc){
      APP.book.service = svc;
      renderBook().catch(()=>{});
      return;
    }

    const catpageEl = t.closest?.('[data-catpage]');
    const catpage = catpageEl?.dataset?.catpage;
    if(catpage){
      if(catpage === 'prev') APP.book.catPage = Math.max(0, (APP.book.catPage||0) - 1);
      if(catpage === 'next') APP.book.catPage = (APP.book.catPage||0) + 1;
      renderBook().catch(()=>{});
      return;
    }

    const profEl = t.closest?.('[data-openprofile]');
    const pid = profEl?.dataset?.openprofile;
    if(pid){
      // If they clicked a follow/unfollow button inside, let that handler run instead.
      if(t.closest?.('[data-follow],[data-unfollow]')) return;
      showPage('profile');
      loadProfileView(pid).catch(()=>{});
      return;
    }






    // Messages tabs/back/actions
    const msgTabEl = t.closest?.('[data-msgtab]');
    if(msgTabEl){
      const tab = msgTabEl.dataset.msgtab;
      APP.msgTab = tab || 'pending';
      byId('msgTabPending')?.classList.toggle('is-on', APP.msgTab==='pending');
      byId('msgTabApproved')?.classList.toggle('is-on', APP.msgTab==='approved');
      const ttl = byId('msgListTitle');
      if(ttl) ttl.textContent = (APP.msgTab==='pending') ? 'Pending threads' : 'Approved threads';
      loadMessages().catch(()=>{});
      return;
    }
    if(t.closest?.('#btnMsgBack') || t.closest?.('[data-backmsg]')){
      const lv = byId('msgListView'); const dv = byId('msgDetailView');
      if(dv) dv.style.display = 'none';
      if(lv) lv.style.display = 'block';
      APP.msg.activeBookingId = null;
      loadMessages().catch(()=>{});
      return;
    }

    const accEl = t.closest?.('[data-accept]');
    if(accEl){
      const id = accEl.dataset.accept;
      acceptBooking(id).then(()=> openThread(id)).catch(()=>{});
      return;
    }
    const cnlEl = t.closest?.('[data-cancel]');
    if(cnlEl){
      const id = cnlEl.dataset.cancel;
      cancelBooking(id).then(()=>{ 
        const lv = byId('msgListView'); const dv = byId('msgDetailView');
        if(dv) dv.style.display = 'none';
        if(lv) lv.style.display = 'block';
        APP.msg.activeBookingId = null;
        loadMessages().catch(()=>{});
      }).catch(()=>{});
      return;
    }
    const confEl = t.closest?.('[data-confirm]');
    if(confEl){
      const id = confEl.dataset.confirm;
      confirmBooking(id).then(()=> openThread(id)).catch(()=>{});
      return;
    }
    const goEl = t.closest?.('[data-goproject]');
    if(goEl){
      showPage('projects');
      loadProjects().catch(()=>{});
      return;
    }






    const unfEl = t.closest?.('[data-unfollow]');
    const unfId = unfEl?.dataset?.unfollow;
    if(unfId){
      toggleFollow(unfId, false).catch(()=>{});
      return;
    }

    const rqEl = t.closest?.('[data-request]');
    const rqId = rqEl?.dataset?.request;
    if(rqId){
      openRequestWizard(rqId).catch(()=>{});
      return;
    }

    const thEl = t.closest?.('[data-thread]');
    const bid = thEl?.dataset?.thread;
    if(bid){
      APP.msg.activeBookingId = bid;
      openThread(bid).catch(()=>{});
      return;
    }
  });

  // menu
  const btnMenu = byId('btnMenu');
  const userMenu = byId('userMenu');
  if(btnMenu && userMenu){
    btnMenu.addEventListener('click', (e)=>{
      e.preventDefault();
      userMenu.classList.toggle('open');
      btnMenu.setAttribute('aria-expanded', userMenu.classList.contains('open') ? 'true' : 'false');
    });
    document.addEventListener('click', (e)=>{
      if(!userMenu.contains(e.target)) userMenu.classList.remove('open');
    });
  }

  // modal close
  byId('modalClose')?.addEventListener('click', closeModal);
  byId('modal')?.addEventListener('click', (e)=>{ if(e.target.id === 'modal') closeModal(); });

  // Book

  byId('btnFind')?.addEventListener('click', ()=> findMatches().catch(()=>{}));
  byId('budget')?.addEventListener('input', (e)=> APP.book.budget = Number(e.target.value || 0));
  byId('catPrev')?.addEventListener('click', ()=>{ APP.book.catPage = Math.max(0, (APP.book.catPage||0)-1); renderBook().catch(()=>{}); });
  byId('catNext')?.addEventListener('click', ()=>{ APP.book.catPage = (APP.book.catPage||0)+1; renderBook().catch(()=>{}); });

  byId('btnCreatorSearch')?.addEventListener('click', ()=> searchCreators().catch(()=>{}));
  byId('creatorSearch')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); searchCreators().catch(()=>{}); }});


  // Create
  byId('btnCreatePackage')?.addEventListener('click', ()=> createPackage().catch(()=>{}));
  byId('btnAddAddon')?.addEventListener('click', ()=>{
    const name = (byId('addonName')?.value || '').trim();
    const price = (byId('addonPrice')?.value || '').trim();
    if(!name) { toast('Add-on name required'); return; }
    const line = price ? `${name} | ${price}` : name;
    const ta = byId('cAddons');
    if(ta){
      ta.value = (ta.value ? ta.value.trimEnd() + '\n' : '') + line;
    }
    if(byId('addonName')) byId('addonName').value='';
    if(byId('addonPrice')) byId('addonPrice').value='';
  });


  byId('cCategory')?.addEventListener('change', ()=> syncCreateServices());
  // Profile
  byId('btnSaveProfile')?.addEventListener('click', ()=> saveProfile().catch(()=>{}));

  // Auth
  byId('btnDoSignIn')?.addEventListener('click', ()=> signIn().catch(()=>{}));
  byId('btnDoSignUp')?.addEventListener('click', ()=> signUp().catch(()=>{}));
  // Enter-to-submit (desktop)
  byId('inPass')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); signIn().catch(()=>{}); }});
  byId('inEmail')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); signIn().catch(()=>{}); }});
  byId('upPass2')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); signUp().catch(()=>{}); }});
  byId('upEmail')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); signUp().catch(()=>{}); }});

  // Profile follow button
  byId('btnFollowProfile')?.addEventListener('click', ()=>{
    const fb = byId('btnFollowProfile');
    const tid = fb?.dataset?.followtarget;
    if(!tid) return;
    const on = fb.dataset.following !== '1';
    toggleFollow(tid, on).catch(()=>{});
    // optimistic UI
    fb.textContent = on ? 'Following' : 'Follow';
    fb.dataset.following = on ? '1' : '0';
  });


  byId('btnShowSignUp')?.addEventListener('click', ()=> byId('signupBox').classList.toggle('hidden'));
  byId('btnForgot')?.addEventListener('click', ()=> forgotPassword().catch(()=>{}));
  byId('btnSignOut')?.addEventListener('click', ()=> signOut().catch(()=>{}));
  byId('btnSendMsg')?.addEventListener('click', ()=> sendCurrentMessage().catch(()=>{}));

  // populate selects
  populateCreateSelects();
}

function populateCreateSelects(){
  const catSel = byId('cCategory');
  const svcSel = byId('cService');
  if(!catSel || !svcSel) return;
  const cats = window.CREATOR_HUB_DATA.categories;
  catSel.innerHTML = cats.map(c => `<option value="${esc(c.label)}">${esc(c.label)}</option>`).join('');
  syncCreateServices();
}

function syncCreateServices(){
  const catSel = byId('cCategory');
  const svcSel = byId('cService');
  if(!catSel || !svcSel) return;
  const cats = window.CREATOR_HUB_DATA.categories;
  const chosen = cats.find(c => c.label === catSel.value) || cats[0];
  svcSel.innerHTML = chosen.services.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

async function hydrateProfile(){
  APP.me = null;
  if(!APP.session?.user) { renderAuthBits(); return; }
  await ensureProfileRow();
  const uid = APP.session.user.id;
  if(!APP.profileView?.id) APP.profileView.id = uid;

  const { data, error } = await APP.sb
    .from('profiles')
    .select('id,username,bio,avatar_url,featured_reel_url')
    .eq('id', uid)
    .maybeSingle();

  if(error){
    console.warn('hydrateProfile', error);
    return;
  }
  APP.me = data || { id: uid };
  renderAuthBits();


async function ensureProfileRow(){
  if(!APP.session?.user) return;
  const uid = APP.session.user.id;
  // Upsert minimal row so FK constraints + updates always work
  const { error } = await APP.sb.from('profiles').upsert({ id: uid }, { onConflict: 'id' });
  if(error) console.warn('ensureProfileRow', error);
}

}


async function renderBook(){
  const cats = window.CREATOR_HUB_DATA.categories || [];
  const catWrap = byId('bookCategories');
  const svcWrap = byId('bookServices');

  const ICONS = {
    music_audio: "🎵",
    video_photo: "🎬",
    design_visual: "🎨",
    writing_creative: "✍️",
    performance_talent: "🎭",
    events_experiences: "🎟️",
    editing_post: "🧩",
    custom_request: "✨",
  };

  const pageSize = 4;
  const totalPages = Math.max(1, Math.ceil(cats.length / pageSize));
  APP.book.catPage = Math.min(Math.max(0, APP.book.catPage || 0), totalPages - 1);

  // pick a default category if none
  if(!APP.book.category && cats[0]) APP.book.category = cats[0].id;

  const pageCats = cats.slice(APP.book.catPage * pageSize, APP.book.catPage * pageSize + pageSize);

  // pager UI
  const lbl = byId('catPageLabel');
  if(lbl) lbl.textContent = `Page ${APP.book.catPage + 1} / ${totalPages}`;
  const prevBtn = byId('catPrev');
  const nextBtn = byId('catNext');
  if(prevBtn) prevBtn.disabled = (APP.book.catPage <= 0);
  if(nextBtn) nextBtn.disabled = (APP.book.catPage >= totalPages - 1);

  if(catWrap){
    catWrap.innerHTML = pageCats.map(c => {
      const on = (APP.book.category) === c.id;
      const icon = ICONS[c.id] || "⬤";
      return `
        <button class="catbtn ${on?'is-on':''}" data-cat="${esc(c.id)}">
          <div class="caticon">${icon}</div>
          <div class="catlabel">${esc(c.label)}</div>
        </button>
      `;
    }).join('');
  }

  const chosenCatId = APP.book.category || (cats[0] ? cats[0].id : null);
  const chosen = cats.find(c => c.id === chosenCatId) || cats[0];

  const svcLabel = byId('svcCatLabel');
  if(svcLabel) svcLabel.textContent = chosen ? chosen.label : 'Services';

  if(svcWrap){
    svcWrap.innerHTML = (chosen?.services || []).map(s => {
      const on = APP.book.service === s;
      return `<button class="svcbtn ${on?'is-on':''}" data-svc="${esc(s)}">${esc(s)}</button>`;
    }).join('');
  }

  // Hint
  byId('matchHint').textContent = (APP.book.service && chosen)
    ? `Searching: ${chosen.label} • ${APP.book.service} • Budget $${APP.book.budget}`
    : 'Select a service, then click Find matches.';

  // clear matches when changing category/service
  byId('matches').innerHTML = '';
  byId('matchesEmpty').style.display = 'none';
}

async function findMatches(){
  const cats = window.CREATOR_HUB_DATA.categories;
  const chosenCatId = APP.book.category || cats[0].id;
  const chosen = cats.find(c => c.id === chosenCatId) || cats[0];

  if(!APP.book.service){
    toast('Pick a service first');
    return;
  }

  const matchesEl = byId('matches');
  const emptyEl = byId('matchesEmpty');
  matchesEl.innerHTML = '';
  emptyEl.style.display = 'none';

  const { data, error } = await APP.sb
    .from('packages')
    .select('id,title,category,service,price_cents,delivery_days,owner,profiles:owner(username,avatar_url)')
    .eq('is_active', true)
    .eq('category', chosen.label)
    .eq('service', APP.book.service)
    .order('created_at', { ascending:false })
    .limit(24);

  if(error){
    console.warn(error);
    toast('Could not load matches. Check RLS + config.');
    return;
  }

  if(!data || data.length === 0){
    emptyEl.style.display = 'block';
    return;
  }

  matchesEl.innerHTML = data.map(p => {
    const u = p.profiles || {};
    const name = u.username ? `@${u.username}` : 'creator';
    return `
      <div class="card">
        <div class="title">${esc(p.title || p.service)}</div>
        <div class="sub">${esc(chosen.label)} • ${esc(p.service)} • <span class="plink" data-openprofile="${esc(p.owner)}">${esc(name)}</span> • ${esc(p.delivery_days)} day delivery</div>
        <div class="row">
          <div class="price">$${esc(usdFromCents(p.price_cents))}</div>
          <button class="btn tiny" data-request="${esc(p.id)}">Request</button>
        </div>
      </div>
    `;
  }).join('');
}

async function openRequestForPackage(packageId){
  return openRequestWizard(packageId);
}

async function openRequestWizard(packageId){
  if(!APP.session?.user){
    APP.pendingRequest = { packageId };
    toast('Sign in to send a request');
    showPage('signin');
    return;
  }

  const { data: pkg, error } = await APP.sb
    .from('packages')
    .select('id,title,service,category,price_cents,delivery_days,owner,addons,profiles:owner(username)')
    .eq('id', packageId)
    .maybeSingle();

  if(error || !pkg){
    console.warn(error);
    toast('Package not found');
    return;
  }

  const creatorName = pkg.profiles?.username ? `@${pkg.profiles.username}` : 'creator';
  const baseCents = pkg.price_cents || 0;

  let addons = [];
  if(Array.isArray(pkg.addons)){
    addons = pkg.addons.map(a => ({
      label: (a.label || a.name || '').toString(),
      price_cents: Number(a.price_cents || a.price || 0)
    })).filter(a => a.label);
  }

  const state = { step: 1, budgetUsd: Number(byId('budget')?.value || APP.book.budget || 200), vision:'', addonsSelected:new Set(), requested_date:'' };

  function renderStep(){
    const step = state.step;
    const totalSteps = 4;

    const addonsHtml = addons.length ? addons.map((a, i)=>{
      const checked = state.addonsSelected.has(i) ? 'checked' : '';
      const extra = a.price_cents ? ` (+$${usdFromCents(a.price_cents)})` : '';
      return `<label class="chk"><input type="checkbox" data-addon="${i}" ${checked}/> ${esc(a.label)}${esc(extra)}</label>`;
    }).join('') : `<div class="muted">No add-ons listed for this package.</div>`;

    const chosenAddonCents = Array.from(state.addonsSelected).reduce((sum,i)=> sum + (addons[i]?.price_cents||0), 0);
    const totalCents = baseCents + chosenAddonCents;

    const calHtml = `
      <div class="muted" style="margin-bottom:10px;">Pick a preferred date. If the creator has availability set, you'll see it below.</div>
      <input id="rqDate" class="input" type="date" value="${esc(state.requested_date)}"/>
      <div id="rqAvail" class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px;"></div>
    `;

    const summary = `
      <div class="card" style="padding:12px;">
        <div class="title">${esc(pkg.title || pkg.service)}</div>
        <div class="sub">${esc(pkg.category)} • ${esc(pkg.service)} • ${esc(creatorName)} • ${esc(pkg.delivery_days)} day delivery</div>
        <div class="muted" style="margin-top:6px;">
          Base: $${esc(usdFromCents(baseCents))}<br/>
          Add-ons: $${esc(usdFromCents(chosenAddonCents))}<br/>
          <b>Total: $${esc(usdFromCents(totalCents))}</b>
        </div>
      </div>
    `;

    openModal(`Request (${step}/${totalSteps})`, `
      <div class="muted" style="margin-bottom:10px;">
        <b>${esc(pkg.title || pkg.service)}</b><br/>
        ${esc(pkg.category)} • ${esc(pkg.service)} • ${esc(creatorName)}<br/>
      </div>

      ${step === 1 ? `
        <label>Your budget (USD)</label>
        <input id="rqBudget" class="input" type="number" min="10" step="10" value="${esc(state.budgetUsd)}"/>
        <label>Your vision / needs</label>
        <textarea id="rqVision" class="input area" placeholder="Describe what you want, vibe, location, references, deadlines...">${esc(state.vision)}</textarea>
      ` : ''}

      ${step === 2 ? `
        <label>Add-ons (optional)</label>
        <div class="col" style="gap:8px;">${addonsHtml}</div>
      ` : ''}

      ${step === 3 ? calHtml : ''}

      ${step === 4 ? `
        ${summary}
        <div class="muted" style="margin-top:10px;">Click Send request to message the creator with the full rundown.</div>
      ` : ''}

      <div class="row between" style="margin-top:12px;">
        <button class="btn ghost" id="rqBack" ${step===1?'disabled':''}>Back</button>
        <div class="row" style="gap:8px;">
          <button class="btn ghost" id="rqCancel">Cancel</button>
          <button class="btn" id="rqNext">${step===4?'Send request':'Next'}</button>
        </div>
      </div>
    `);

    byId('rqCancel')?.addEventListener('click', closeModal);
    byId('rqBack')?.addEventListener('click', ()=>{ state.step = Math.max(1, state.step-1); renderStep(); });

    if(step === 1){
      byId('rqBudget')?.addEventListener('input', ()=> state.budgetUsd = Number(byId('rqBudget').value||state.budgetUsd));
      byId('rqVision')?.addEventListener('input', ()=> state.vision = byId('rqVision').value);
    }

    if(step === 2){
      $$('#modal [data-addon]').forEach(inp=>{
        inp.addEventListener('change', ()=>{
          const idx = Number(inp.dataset.addon);
          if(inp.checked) state.addonsSelected.add(idx); else state.addonsSelected.delete(idx);
        });
      });
    }

    if(step === 3){
      byId('rqDate')?.addEventListener('change', ()=> state.requested_date = byId('rqDate').value);
      loadAvailabilityChips(pkg.owner, state).catch(()=>{});
    }

    byId('rqNext')?.addEventListener('click', async ()=>{
      if(step === 1){
        state.budgetUsd = Number(byId('rqBudget').value || state.budgetUsd);
        state.vision = byId('rqVision').value || '';
        if(!state.vision.trim()){ toast('Add a short vision message'); return; }
        state.step = 2; renderStep(); return;
      }
      if(step === 2){ state.step = 3; renderStep(); return; }
      if(step === 3){
        state.requested_date = byId('rqDate')?.value || state.requested_date;
        if(!state.requested_date){ toast('Pick a date'); return; }
        state.step = 4; renderStep(); return;
      }

      const chosenAddonObjs = Array.from(state.addonsSelected).map(i => addons[i]).filter(Boolean);
      const addonsCents = chosenAddonObjs.reduce((sum,a)=>sum+(a.price_cents||0),0);
      const totalCents2 = baseCents + addonsCents;

      const insertPayload = {
        package_id: pkg.id,
        requester: APP.session.user.id,
        creator: pkg.owner,
        status: 'requested',
        budget_cents: centsFromUsd(state.budgetUsd),
        message: state.vision,
        vision: state.vision,
        addons_selected: chosenAddonObjs,
        requested_date: state.requested_date,
        total_cents: totalCents2,
        requester_confirmed: false,
        creator_confirmed: false
      };

      let bookingId = null;
      const { data: bRow, error: bErr } = await APP.sb.from('bookings').insert(insertPayload).select('id').maybeSingle();
      if(bErr){
        console.warn(bErr);
        if((bErr.message||'').includes('column') || (bErr.code === '42703')){
          const { data: bRow2, error: bErr2 } = await APP.sb.from('bookings').insert({
            package_id: pkg.id,
            requester: APP.session.user.id,
            creator: pkg.owner,
            status: 'requested',
            budget_cents: centsFromUsd(state.budgetUsd),
            message: state.vision
          }).select('id').maybeSingle();
          if(bErr2){ console.warn(bErr2); toast('Could not send request (run patch SQL).'); return; }
          bookingId = bRow2?.id || null;
        }else{ toast('Could not send request (check RLS).'); return; }
      }else bookingId = bRow?.id || null;

      if(bookingId){
        const rundown = `Request for: ${pkg.title || pkg.service}\nCategory: ${pkg.category}\nService: ${pkg.service}\nBase: $${usdFromCents(baseCents)}\nAdd-ons: $${usdFromCents(addonsCents)}\nTotal: $${usdFromCents(totalCents2)}\nPreferred date: ${state.requested_date}`;
        await APP.sb.from('booking_messages').insert([
          { booking_id: bookingId, sender: APP.session.user.id, body: rundown, is_system: true },
          { booking_id: bookingId, sender: APP.session.user.id, body: state.vision, is_system: false }
        ]).catch(()=>{});
      }

      closeModal();
      toast('Request sent');
      showPage('messages');
      await loadMessages();
    });
  }

  renderStep();
}

async function loadAvailabilityChips(userId, state){
  const wrap = byId('rqAvail');
  if(!wrap) return;
  wrap.innerHTML = '<span class="muted">Loading availability…</span>';

  const today = new Date();
  const end = new Date(); end.setDate(end.getDate()+60);

  const { data, error } = await APP.sb
    .from('availability_dates')
    .select('day')
    .eq('user_id', userId)
    .gte('day', today.toISOString().slice(0,10))
    .lte('day', end.toISOString().slice(0,10))
    .order('day', { ascending:true });

  if(error){ wrap.innerHTML = '<span class="muted">No availability data.</span>'; return; }
  if(!data || !data.length){ wrap.innerHTML = '<span class="muted">Creator hasn\'t set availability yet.</span>'; return; }

  wrap.innerHTML = data.slice(0,14).map(r=>{
    const d = r.day;
    const on = state.requested_date === d;
    return `<button class="btn tiny ${on?'':'ghost'}" data-pickdate="${esc(d)}">${esc(d)}</button>`;
  }).join('');

  $$('#rqAvail [data-pickdate]').forEach(b=>{
    b.addEventListener('click', ()=>{
      state.requested_date = b.dataset.pickdate;
      const inp = byId('rqDate'); if(inp) inp.value = state.requested_date;
      loadAvailabilityChips(userId, state).catch(()=>{});
    });
  });
}


async function createPackage(){
  const status = byId('createStatus');
  if(status) status.textContent = '';
  if(!APP.session?.user){
    toast('Sign in to create packages');
    showPage('signin');
    return;
  }

  await ensureProfileRow();

  const cat = byId('cCategory').value;
  const svc = byId('cService').value;
  const title = byId('cTitle').value.trim();
  const equipment = byId('cEquipment').value.trim();
  const delivery = Number(byId('cDelivery').value || 7);
  const priceUsd = Number(byId('cPrice').value || 0);
  const included = byId('cIncluded').value.trim();
  const addonsRaw = (byId('cAddons').value || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const images = ((byId('cImages')?.value) || '').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,4);
  const video = ((byId('cVideo')?.value) || '').trim();
  const imgFiles = Array.from(byId('cImagesFile')?.files || []).slice(0,4);
  const vidFile = (byId('cVideoFile')?.files && byId('cVideoFile').files[0]) ? byId('cVideoFile').files[0] : null;

  if(!title){
    toast('Add a title');
    return;
  }
  if(priceUsd < 10){
    toast('Set a price (at least $10)');
    return;
  }


  // Upload media (optional)
  let image_urls = images.length ? images : null;
  let video_url = video || null;

  try{
    if(imgFiles.length){
      const urls = [];
      for(const f of imgFiles){
        const u = await uploadToStorage('creatorhub', 'packages/images', f);
        if(u) urls.push(u);
      }
      image_urls = urls.length ? urls : null;
    }
    if(vidFile){
      const u = await uploadToStorage('creatorhub', 'packages/videos', vidFile);
      video_url = u || null;
    }
  }catch(err){
    console.warn('upload', err);
    if(status) status.textContent = (err?.message || '') + ' ' + storageSetupHint();
    toast('Media upload failed (Storage)');
  }
  await ensureProfileRow();

  const payload = {
    owner: APP.session.user.id,
    category: cat,
    service: svc,
    title,
    equipment,
    delivery_days: Math.max(1, delivery|0),
    included,
    addons: parseAddonsWithPricing(addonsRaw),
    price_cents: centsFromUsd(priceUsd),
    image_urls,
    video_url,
    is_active: true
  };

  const { error } = await APP.sb.from('packages').insert(payload);
  if(error){
    console.warn(error);
    if(status) status.textContent = error.message;
    toast('Could not create package');
    return;
  }
  if(status) status.textContent = 'Package created.';
  toast('Package created');
  // clear a bit
  if(byId('cImagesFile')) byId('cImagesFile').value='';
  if(byId('cVideoFile')) byId('cVideoFile').value='';
  byId('cTitle').value = '';
  byId('cEquipment').value = '';
  byId('cIncluded').value = '';
  byId('cAddons').value = '';
  byId('cImages').value = '';
  byId('cVideo').value = '';
}

async function loadProjects(){
  if(!APP.session?.user) return;
  const wrap = byId('projects');
  const empty = byId('projectsEmpty');
  wrap.innerHTML = '';
  empty.style.display = 'none';

  const uid = APP.session.user.id;
  if(!APP.profileView?.id) APP.profileView.id = uid;

  const { data, error } = await APP.sb
    .from('bookings')
    .select('id,status,budget_cents,message,created_at,packages:package_id(title,service,category,price_cents,delivery_days),requester,creator')
    .or(`requester.eq.${uid},creator.eq.${uid}`)
    .order('created_at', { ascending:false })
    .limit(50);

  if(error){
    console.warn(error);
    toast('Could not load projects');
    return;
  }
  if(!data || data.length === 0){
    empty.style.display = 'block';
    return;
  }

  wrap.innerHTML = data.map(b => {
    const p = b.packages || {};
    const role = (b.creator === uid) ? 'Creator' : 'Requester';
    return `
      <div class="card">
        <div class="title">${esc(p.title || p.service || 'Project')}</div>
        <div class="sub">${esc(p.category || '')} • ${esc(p.service || '')} • ${esc(role)} • status: <b>${esc(b.status)}</b></div>
        <div class="row">
          <div class="price">Budget $${esc(usdFromCents(b.budget_cents))}</div>
          <div class="muted small">${esc(new Date(b.created_at).toLocaleString())}</div>
        </div>
      </div>
    `;
  }).join('');
}


async function loadMessages(){
  requireAuth();
  const uid = APP.session.user.id;

  const threadsEl = byId('msgThreads');
  const emptyEl = byId('msgThreadsEmpty');
  if(threadsEl) threadsEl.innerHTML = '';
  if(emptyEl) emptyEl.style.display = 'none';

  // Pull participant bookings
  const { data: bookings, error } = await APP.sb
    .from('bookings')
    .select(`
      id, status, created_at, requested_date, total_cents, message, vision,
      requester, creator,
      packages:package_id ( id, title, category, service, price_cents )
    `)
    .or(`requester.eq.${uid},creator.eq.${uid}`)
    .order('created_at', { ascending:false });

  if(error){
    console.warn(error);
    toast('Could not load messages');
    return;
  }

  const list = (bookings||[]).filter(b=>{
    const st = (b.status||'requested');
    if(APP.msgTab === 'pending') return st === 'requested';
    return st !== 'requested' && st !== 'cancelled';
  });

  const otherIds = Array.from(new Set(list.map(b=>{
    const isRequester = b.requester === uid;
    return isRequester ? b.creator : b.requester;
  }).filter(Boolean)));

  const nameMap = {};
  if(otherIds.length){
    const { data: profs } = await APP.sb.from('profiles').select('id,username,avatar_url').in('id', otherIds);
    (profs||[]).forEach(p=>nameMap[p.id]=p);
  }

  if(!list.length){
    if(emptyEl){ emptyEl.style.display = 'block'; emptyEl.textContent = APP.msgTab==='pending' ? 'No pending requests.' : 'No approved threads yet.'; }
    const c = byId('msgThreadCount'); if(c){ c.style.display='none'; }
    return;
  }

  if(threadsEl){
    threadsEl.innerHTML = list.map(b=>{
      const isRequester = b.requester === uid;
      const otherId = isRequester ? b.creator : b.requester;
      const other = nameMap[otherId] || {};
      const otherName = other.username ? `@${other.username}` : 'user';
      const title = b.packages?.title || 'Project';
      const status = b.status || 'requested';
      const note = b.message ? String(b.message).trim() : '';
      const sub = note ? note : (b.requested_date ? `preferred ${b.requested_date}` : 'tap to open');
      const price = b.total_cents ? '$'+usdFromCents(b.total_cents) : (b.packages?.price_cents ? '$'+usdFromCents(b.packages.price_cents) : '');
      const av = other.avatar_url ? `<img class="avimg" src="${esc(other.avatar_url)}" alt="">` : `<div class="avtxt">${esc((otherName||'u').replace('@','').slice(0,1).toUpperCase())}</div>`;
      return `
        <button class="threadCard" data-thread="${esc(b.id)}">
          <div class="tleft">
            <div class="avatar sm msgAv">${av}</div>
            <div style="min-width:0;flex:1;">
              <div class="tname">${esc(title)}</div>
              <div class="tsub">${esc(otherName)} • ${esc(sub)}</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <div class="tbadge">${esc(status)}</div>
            <div class="tprice">${esc(price)}</div>
          </div>
        </button>
      `;
    }).join('');

    const c = byId('msgThreadCount');
    if(c){ c.style.display='inline-flex'; c.textContent = list.length + ' threads'; }
  }
}



async function renderMsgLog(bookingId, uid){
  const log = byId('msgLog');
  if(log) log.innerHTML = '';
  const { data: msgs, error } = await APP.sb
    .from('booking_messages')
    .select('id,sender,body,is_system,created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending:true });

  if(error){
    console.warn(error);
    toast('Could not load chat');
    return;
  }
  const items = msgs || [];
  if(!items.length){
    if(log) log.innerHTML = '<div class="muted">No messages yet.</div>';
    return;
  }
  if(log){
    log.innerHTML = items.map(m=>{
      const me = (m.sender === uid);
      const cls = me ? 'bubble me' : 'bubble';
      const time = new Date(m.created_at).toLocaleString();
      return `<div class="${cls}">${esc(m.body)}<div class="bmeta">${esc(time)}</div></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }
}

async function openThread(bookingId){
  requireAuth();
  const uid = APP.session.user.id;
  APP.msg.activeBookingId = bookingId;

  // toggle views
  const lv = byId('msgListView');
  const dv = byId('msgDetailView');
  if(lv) lv.style.display = 'none';
  if(dv) dv.style.display = 'block';

  // load booking
  const { data: b, error } = await APP.sb
    .from('bookings')
    .select(`
      id,status,created_at,requested_date,total_cents,message,vision,
      requester,creator,
      packages:package_id ( id,title,category,service,price_cents,addons )
    `)
    .eq('id', bookingId)
    .maybeSingle();

  if(error || !b){
    console.warn(error);
    toast('Could not open thread');
    return;
  }

  const isRequester = b.requester === uid;
  const peerId = isRequester ? b.creator : b.requester;

  // peer profile
  let peer = null;
  if(peerId){
    const { data: p } = await APP.sb.from('profiles').select('id,username,avatar_url').eq('id', peerId).maybeSingle();
    peer = p || null;
  }
  const peerName = peer?.username ? '@'+peer.username : 'user';

  // follower counts (requires follows select policy)
  let followerCount = 0, followingCount = 0;
  if(peerId){
    const { count: c1 } = await APP.sb.from('follows').select('*', { count:'exact', head:true }).eq('following', peerId);
    const { count: c2 } = await APP.sb.from('follows').select('*', { count:'exact', head:true }).eq('follower', peerId);
    followerCount = c1 || 0;
    followingCount = c2 || 0;
  }

  // header
  const avEl = byId('msgPeerAvatar');
  const nameEl = byId('msgPeerName');
  const statsEl = byId('msgPeerStats');
  if(nameEl){ nameEl.textContent = peerName; nameEl.setAttribute('data-openprofile', peerId||''); }
  if(statsEl){ statsEl.textContent = `${followerCount} followers • ${followingCount} following`; }
  if(avEl){
    avEl.innerHTML = peer?.avatar_url ? `<img class="avimg" src="${esc(peer.avatar_url)}" alt="">` : `<div class="avtxt">${esc(peerName.replace('@','').slice(0,1).toUpperCase())}</div>`;
    avEl.setAttribute('data-openprofile', peerId||'');
  }

  const packTitle = b.packages?.title || 'Project';
  const meta = byId('msgMeta');
  if(meta){
    meta.textContent = `${packTitle} • ${b.status}${b.requested_date?` • preferred ${b.requested_date}`:''}${b.total_cents?` • $${usdFromCents(b.total_cents)}`:''}`;
  }

  // summary + composer lock
  const sum = byId('msgSummary');
  if(sum){
    sum.style.display = 'block';
    const v = (b.vision||'').trim();
    const note = (b.message||'').trim();
    const msg = v ? v : (note ? note : '');
    sum.textContent = b.status === 'requested'
      ? (msg ? `Buyer note: ${msg}` : 'Pending request. Accept to open chat.')
      : (b.status === 'accepted' ? 'Accepted. Chat is open. Both parties can confirm to lock it in.' : `Status: ${b.status}`);
  }

  const composer = byId('msgComposer');
  if(composer){
    const locked = (b.status === 'requested'); // chat locked until accepted
    composer.style.display = locked ? 'none' : 'block';
    const hint = byId('msgHint');
    if(hint) hint.textContent = locked ? 'Accept to unlock chat.' : '';
  }

  // actions
  const act = byId('msgActions');
  if(act){
    act.innerHTML = '';
    const btn = (label, cls, dataAttr, val) => `<button class="btn ${cls||''}" ${dataAttr}="${esc(val)}">${esc(label)}</button>`;

    if(b.status === 'requested'){
      if(!isRequester){
        act.innerHTML += btn('Accept', '', 'data-accept', b.id);
        act.innerHTML += btn('Reject', 'ghost', 'data-cancel', b.id);
      } else {
        act.innerHTML += btn('Cancel', 'ghost', 'data-cancel', b.id);
      }
      act.innerHTML += btn('Later', 'ghost', 'data-backmsg', '1');
    } else if(b.status === 'accepted'){
      act.innerHTML += btn(isRequester ? 'Confirm (buyer)' : 'Confirm (creator)', '', 'data-confirm', b.id);
      act.innerHTML += btn('Cancel', 'ghost', 'data-cancel', b.id);
    } else if(b.status === 'in_progress' || b.status === 'delivered' || b.status === 'completed'){
      act.innerHTML += btn('View in Projects', '', 'data-goproject', b.id);
    }
  }

  // load chat log
  await renderMsgLog(b.id, uid);
}

async function sendCurrentMessage(){
  requireAuth();
  const uid = APP.session.user.id;
  const bookingId = APP.msg.activeBookingId;
  if(!bookingId) return;

  const input = byId('msgInput');
  const body = (input?.value || '').trim();
  if(!body) return;

  const { error } = await APP.sb.from('booking_messages').insert({
    booking_id: bookingId,
    sender: uid,
    body,
    is_system: false
  });

  if(error){
    console.warn(error);
    toast('Message failed');
    return;
  }
  if(input) input.value = '';
  await renderMsgLog(bookingId, uid);
}



async function acceptBooking(id){
  requireAuth();
  const uid = APP.session.user.id;
  // only creator should accept; enforced by RLS on bookings update (participants)
  const { error } = await APP.sb.from('bookings').update({ status:'accepted' }).eq('id', id);
  if(error){ console.warn(error); toast('Accept failed'); return; }
  // system message
  await APP.sb.from('booking_messages').insert({ booking_id:id, sender:uid, body:'✅ Accepted. Chat unlocked.', is_system:true }).catch(()=>{});
}

async function cancelBooking(id){
  requireAuth();
  const uid = APP.session.user.id;
  const { error } = await APP.sb.from('bookings').update({ status:'cancelled' }).eq('id', id);
  if(error){ console.warn(error); toast('Cancel failed'); return; }
  await APP.sb.from('booking_messages').insert({ booking_id:id, sender:uid, body:'❌ Cancelled.', is_system:true }).catch(()=>{});
}

async function confirmBooking(id){
  requireAuth();
  const uid = APP.session.user.id;

  // Try to use per-side confirmation columns if they exist.
  // If they don't exist yet, we fall back to immediate in_progress (still stable, no crashes).
  let b = null;
  try{
    const r = await APP.sb.from('bookings')
      .select('id,status,requester,creator,requester_confirmed,creator_confirmed')
      .eq('id', id).maybeSingle();
    b = r.data || null;
    if(r.error) throw r.error;
  }catch(e){
    // fallback: just move to in_progress if accepted
    const r2 = await APP.sb.from('bookings').select('id,status').eq('id', id).maybeSingle();
    const st = r2.data?.status || '';
    if(st === 'accepted'){
      await APP.sb.from('bookings').update({ status:'in_progress' }).eq('id', id).catch(()=>{});
      await APP.sb.from('booking_messages').insert({ booking_id:id, sender:uid, body:'🔒 Confirmed. Project is now active.', is_system:true }).catch(()=>{});
      return;
    }
    toast('Not ready to confirm');
    return;
  }

  if(!b){ toast('Confirm failed'); return; }
  if(b.status !== 'accepted'){ toast('Not ready to confirm'); return; }

  const patch = {};
  if(uid === b.requester) patch.requester_confirmed = true;
  if(uid === b.creator) patch.creator_confirmed = true;

  const { error: uErr } = await APP.sb.from('bookings').update(patch).eq('id', id);
  if(uErr){ console.warn(uErr); toast('Confirm failed'); return; }

  const { data: b2 } = await APP.sb.from('bookings').select('requester_confirmed,creator_confirmed').eq('id', id).maybeSingle();
  if(b2?.requester_confirmed && b2?.creator_confirmed){
    await APP.sb.from('bookings').update({ status:'in_progress' }).eq('id', id).catch(()=>{});
    await APP.sb.from('booking_messages').insert({ booking_id:id, sender:uid, body:'🔒 Confirmed by both. Project is now active.', is_system:true }).catch(()=>{});
  } else {
    await APP.sb.from('booking_messages').insert({ booking_id:id, sender:uid, body:'✅ Confirmed.', is_system:true }).catch(()=>{});
  }
}




async function loadFeed(){
  const feed = byId('feed');
  const empty = byId('feedEmpty');
  if(!feed || !empty) return;
  feed.innerHTML = '';
  empty.style.display = 'none';

  // Following mode: requires auth
  if(APP.feedMode === 'following' && !APP.session?.user){
    empty.style.display = 'block';
    empty.textContent = 'Sign in to see posts from people you follow.';
    return;
  }

  let query = APP.sb.from('posts_public')
    .select('id,body,media_url,created_at,author,username,avatar_url')
    .order('created_at', { ascending:false })
    .limit(30);

  if(APP.feedMode === 'following'){
    // filter by follows table
    const uid = APP.session.user.id;
    const { data: following, error: fErr } = await APP.sb
      .from('follows')
      .select('following')
      .eq('follower', uid);

    if(fErr){
      console.warn(fErr);
      toast('Could not load following');
      return;
    }
    const ids = (following || []).map(x => x.following);
    if(ids.length === 0){
      empty.style.display = 'block';
      empty.textContent = "You're not following anyone yet.";
      return;
    }
    query = query.in('author', ids);
  }

  const { data, error } = await query;
  if(error){
    console.warn(error);
    empty.style.display = 'block';
    empty.textContent = 'Could not load posts (check SQL view + RLS).';
    return;
  }
  if(!data || data.length === 0){
    empty.style.display = 'block';
    return;
  }

  feed.innerHTML = data.map(p => `
    <div class="post">
      <div class="meta">
        <div>${esc(p.username ? '@'+p.username : 'creator')}</div>
        <div>${esc(new Date(p.created_at).toLocaleDateString())}</div>
      </div>
      <div class="body">${esc(p.body || '')}</div>
      ${p.media_url ? `<div class="muted small" style="margin-top:8px;">media: ${esc(p.media_url)}</div>` : ''}
    </div>
  `).join('');
}


async function loadFollowStats(){
  if(!APP.session?.user) return;
  const uid = APP.session.user.id;
  if(!APP.profileView?.id) APP.profileView.id = uid;

  const followersEl = byId('followersCount');
  const followingEl = byId('followingCount');

  // followers = people who follow me
  const { count: followersCount, error: e1 } = await APP.sb
    .from('follows')
    .select('*', { count:'exact', head:true })
    .eq('following', tid);

  // following = people I follow
  const { count: followingCount, error: e2 } = await APP.sb
    .from('follows')
    .select('*', { count:'exact', head:true })
    .eq('follower', tid);

  if(e1) console.warn(e1);
  if(e2) console.warn(e2);

  if(followersEl) followersEl.textContent = String(followersCount || 0);
  if(followingEl) followingEl.textContent = String(followingCount || 0);
}

async function searchCreators(){
  if(!APP.session?.user){
    toast('Sign in to search creators');
    showPage('signin');
    return;
  }
  const term = (byId('creatorSearch')?.value || '').trim();
  const out = byId('creatorResults');
  if(!out) return;

  if(term.length < 1){
    out.innerHTML = '<div class="muted small">Type a username to search.</div>';
    return;
  }

  const { data: creators, error } = await APP.sb
    .from('profiles')
    .select('id,username,bio,avatar_url')
    .ilike('username', `%${term}%`)
    .limit(20);

  if(error){
    console.warn(error);
    out.innerHTML = '<div class="muted small">Could not search right now.</div>';
    return;
  }

  const list = (creators || []).filter(c => c.username);
  if(list.length === 0){
    out.innerHTML = '<div class="muted small">No matches.</div>';
    return;
  }

  // load follow state
  const ids = list.map(x => x.id);
  const { data: following, error: fErr } = await APP.sb
    .from('follows')
    .select('following')
    .eq('follower', APP.session.user.id)
    .in('following', ids);

  if(fErr) console.warn(fErr);
  const set = new Set((following||[]).map(x=>x.following));

  out.innerHTML = list.map(c => {
    const isMe = c.id === APP.session.user.id;
    const isFollowing = set.has(c.id);
    const btn = isMe ? '' : (isFollowing
      ? `<button class="btn tiny ghost" data-unfollow="${esc(c.id)}">Unfollow</button>`
      : `<button class="btn tiny" data-follow="${esc(c.id)}">Follow</button>`);
    const avatar = c.avatar_url ? `<img class="avatar" src="${esc(c.avatar_url)}" alt="">` : `<div class="avatar ph"></div>`;
    return `
      <div class="creatorCard" data-openprofile="${esc(c.id)}">
        ${avatar}
        <div class="creatorMeta">
          <div class="creatorName">@${esc(c.username)}</div>
          <div class="muted small">${esc(c.bio || '')}</div>
        </div>
        <div class="creatorActions">${btn}</div>
      </div>
    `;
  }).join('');
}

async function loadMyPackages(){
  if(!APP.session?.user) return;
  const wrap = byId('myPackages');
  if(!wrap) return;

  const { data, error } = await APP.sb
    .from('packages')
    .select('id,category,service,title,price_cents,delivery_days,is_active,created_at')
    .eq('owner', APP.session.user.id)
    .order('created_at', { ascending:false })
    .limit(8);

  if(error){
    console.warn('loadMyPackages', error);
    wrap.innerHTML = `<div class="muted small">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if(!rows.length){
    wrap.innerHTML = `<div class="muted small">No packages yet. Create one to appear here.</div>`;
    return;
  }

  wrap.innerHTML = rows.map(p => `
    <div class="pkgcard">
      <div class="t">${esc(p.title)}</div>
      <div class="meta">${esc(p.category)} • ${esc(p.service)} • $${(p.price_cents||0)/100} • ${esc(String(p.delivery_days||7))}d</div>
      <div class="meta">${p.is_active ? 'Active' : 'Hidden'}</div>
    </div>
  `).join('');
}


async function toggleFollow(targetId, on){
  if(!APP.session?.user) return;
  const uid = APP.session.user.id;
  if(!APP.profileView?.id) APP.profileView.id = uid;
  if(targetId === uid) return;

  if(on){
    const { error } = await APP.sb.from('follows').insert({ follower: uid, following: targetId });
    if(error){
      // ignore duplicate
      if(!String(error.message||'').toLowerCase().includes('duplicate')) console.warn(error);
    }else{
      toast('Followed');
    }
  }else{
    const { error } = await APP.sb.from('follows').delete().eq('follower', uid).eq('following', targetId);
    if(error) console.warn(error);
    toast('Unfollowed');
  }

  // refresh stats if on profile page
  loadFollowStats().catch(()=>{});
  // refresh feed if on following mode
  if(APP.feedMode === 'following') loadFeed().catch(()=>{});
  // refresh current search results
  if(byId('creatorSearch') && byId('creatorResults') && APP.route === 'book') searchCreators().catch(()=>{});
}


function setProfileTab(tab){
  APP.profileView.tab = tab;
  $$('#profileTabs .tab').forEach(b => b.classList.toggle('is-on', b.dataset.profiletab === tab));
  $$('.tabpane').forEach(p => p.classList.toggle('is-on', p.dataset.pane === tab));
  // Lazy load content
  if(APP.route === 'profile'){
    if(tab === 'posts') loadProfilePosts(APP.profileView.id).catch(()=>{});
    if(tab === 'packages') loadProfilePackages(APP.profileView.id).catch(()=>{});
  }
}

async function loadProfileView(userId){
  if(!userId) return;
  APP.profileView.id = userId;

  // Fetch profile row
  const { data: prof, error } = await APP.sb.from('profiles')
    .select('id,username,bio,avatar_url,featured_reel_url')
    .eq('id', userId).single();

  if(error){
    console.warn('loadProfileView', error);
    toast('Could not load profile');
    return;
  }

  const isMe = !!APP.session?.user && APP.session.user.id === userId;

  // header
  const nameEl = byId('profileName');
  if(nameEl) nameEl.textContent = prof.username ? '@'+prof.username : '@user';
  const metaEl = byId('profileMeta');
  if(metaEl) metaEl.textContent = prof.bio ? prof.bio : (isMe ? 'Add a bio in Settings' : 'creator hub profile');

  const prev = byId('avatarPreview');
  if(prev){
    const url = (prof.avatar_url || '').trim();
    prev.src = url || '';
    prev.style.display = url ? '' : 'none';
  }

  // follow button (only for others)
  const fb = byId('btnFollowProfile');
  if(fb){
    fb.style.display = (!isMe && APP.session?.user) ? '' : 'none';
    fb.dataset.followtarget = userId;
    // state
    let following = false;
    if(APP.session?.user){
      const { data: rel } = await APP.sb.from('follows').select('follower,following').eq('follower', APP.session.user.id).eq('following', userId).maybeSingle();
      following = !!rel;
    }

        fb.textContent = following ? 'Following' : 'Follow';
    fb.dataset.following = following ? '1' : '0';
  }

  // counts
  loadFollowStats(userId).catch(()=>{});

  // show correct tabs (settings only if me)
  const settingsTab = $('#profileTabs [data-profiletab="settings"]');
  if(settingsTab) settingsTab.style.display = isMe ? '' : 'none';

  // preload settings fields if me
  if(isMe){
    byId('pUsername').value = prof.username || '';
    byId('pBio').value = prof.bio || '';
    byId('pAvatar').value = prof.avatar_url || '';
    byId('pReel').value = prof.featured_reel_url || '';
  }

  // Load current tab content
  setProfileTab(APP.profileView.tab || 'posts');
  await loadProfilePosts(userId).catch(()=>{});
}

async function loadProfilePosts(userId){
  const wrap = byId('profilePosts');
  const empty = byId('profilePostsEmpty');
  if(!wrap || !empty) return;
  wrap.innerHTML = '';
  empty.style.display = 'none';

  const { data, error } = await APP.sb.from('posts_public')
    .select('id,body,media_url,created_at,author,username,avatar_url')
    .eq('author', userId)
    .order('created_at', { ascending:false })
    .limit(30);

  if(error){
    console.warn('profile posts', error);
    empty.style.display = 'block';
    empty.textContent = 'Could not load posts.';
    return;
  }
  if(!data || data.length === 0){
    empty.style.display = 'block';
    return;
  }
  wrap.innerHTML = data.map(p => `
    <div class="post">
      <div class="meta">
        <div>${esc(p.username ? '@'+p.username : 'creator')}</div>
        <div>${esc(new Date(p.created_at).toLocaleDateString())}</div>
      </div>
      <div class="body">${esc(p.body || '')}</div>
      ${p.media_url ? `<div class="muted small" style="margin-top:8px;">media: ${esc(p.media_url)}</div>` : ''}
    </div>
  `).join('');
}

async function loadProfilePackages(userId){
  const wrap = byId('profilePackages');
  const empty = byId('profilePackagesEmpty');
  if(!wrap || !empty) return;
  wrap.innerHTML = '';
  empty.style.display = 'none';

  const isMe = !!APP.session?.user && APP.session.user.id === userId;

  let q = APP.sb.from('packages')
    .select('id,category,service,title,price_cents,delivery_days,is_active,created_at')
    .eq('owner', userId)
    .order('created_at', { ascending:false })
    .limit(30);

  if(!isMe) q = q.eq('is_active', true);

  const { data, error } = await q;
  if(error){
    console.warn('profile packages', error);
    empty.style.display = 'block';
    empty.textContent = 'Could not load packages.';
    return;
  }
  const rows = data || [];
  if(!rows.length){
    empty.style.display = 'block';
    return;
  }

  wrap.innerHTML = rows.map(p => `
    <div class="pkgcard">
      <div class="t">${esc(p.title)}</div>
      <div class="meta">${esc(p.category)} • ${esc(p.service)} • $${(p.price_cents||0)/100} • ${esc(String(p.delivery_days||7))}d</div>
      ${isMe ? `<div class="meta">${p.is_active ? 'Active' : 'Hidden'}</div>` : ''}
    </div>
  `).join('');
}

async function loadProfile(){
  if(!APP.session?.user) return;
  byId('pUsername').value = APP.me?.username || '';
  byId('pBio').value = APP.me?.bio || '';
  byId('pAvatar').value = APP.me?.avatar_url || '';
  byId('pReel').value = APP.me?.featured_reel_url || '';

  const prev = byId('avatarPreview');
  if(prev){
    const url = (APP.me?.avatar_url || '').trim();
    prev.src = url || '';
    prev.style.display = url ? '' : 'none';
  }

  loadFollowStats().catch(()=>{});
  loadMyPackages().catch(()=>{});
}

async function saveProfile(){
  if(!APP.session?.user) return;
  const status = byId('profileStatus');
  status.textContent = '';


  // optional avatar upload
  try{
    const f = (byId('pAvatarFile')?.files && byId('pAvatarFile').files[0]) ? byId('pAvatarFile').files[0] : null;
    if(f){
      const url = await uploadToStorage('creatorhub', 'avatars', f);
      if(url){
        byId('pAvatar').value = url;
        const prev = byId('avatarPreview');
        if(prev){ prev.src = url; prev.style.display = ''; }
      }
    }
  }catch(err){
    console.warn('avatar upload', err);
    status.textContent = (err?.message || '') + ' ' + storageSetupHint();
    toast('Avatar upload failed (Storage)');
  }

  const payload = {
    username: (byId('pUsername').value || '').trim() || null,
    bio: (byId('pBio').value || '').trim() || null,
    avatar_url: (byId('pAvatar').value || '').trim() || null,
    featured_reel_url: (byId('pReel').value || '').trim() || null,
  };

    const uid = APP.session.user.id;
  const { error } = await APP.sb.from('profiles').upsert({ id: uid, ...payload }, { onConflict: 'id' });
  if(error){
    console.warn(error);
    status.textContent = error.message;
    toast('Could not save profile');
    return;
  }
  status.textContent = 'Saved.';
  toast('Saved');
  if(byId('pAvatarFile')) byId('pAvatarFile').value='';
  await hydrateProfile();
  renderAuthBits();
  // refresh visible profile view
  try{ await loadProfileView(APP.session.user.id); }catch(e){}
}

async function signIn(){
  const msg = byId('authMsg');
  msg.textContent = '';

  const email = (byId('inEmail').value || '').trim();
  const pass = (byId('inPass').value || '').trim();

  if(!isEmail(email)){
    msg.textContent = 'Use your email to sign in (username sign-in needs a custom backend).';
    return;
  }
  if(pass.length < 6){
    msg.textContent = 'Password too short.';
    return;
  }

  const { error } = await APP.sb.auth.signInWithPassword({ email, password: pass });
  if(error){
    msg.textContent = error.message;
    return;
  }
  toast('Signed in');
}

async function signUp(){
  const msg = byId('upMsg');
  msg.textContent = '';

  const email = (byId('upEmail').value || '').trim();
  const pass = (byId('upPass').value || '').trim();
  const pass2 = (byId('upPass2').value || '').trim();

  if(!isEmail(email)){ msg.textContent = 'Enter a valid email.'; return; }
  if(pass.length < 6){ msg.textContent = 'Password must be at least 6 characters.'; return; }
  if(pass !== pass2){ msg.textContent = 'Passwords do not match.'; return; }

  const redirectTo = window.location.origin + window.location.pathname; // docs/index.html
  const { error } = await APP.sb.auth.signUp({ email, password: pass, options:{ emailRedirectTo: redirectTo } });
  if(error){
    msg.textContent = error.message;
    return;
  }
  msg.textContent = 'Account created. Check email to confirm (if confirmation is enabled). Then sign in.';
  toast('Account created');
}

async function forgotPassword(){
  const msg = byId('authMsg');
  msg.textContent = '';
  const email = (byId('inEmail').value || '').trim();
  if(!isEmail(email)){ msg.textContent = 'Enter your email above, then click forgot password.'; return; }
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await APP.sb.auth.resetPasswordForEmail(email, { redirectTo });
  if(error){ msg.textContent = error.message; return; }
  msg.textContent = 'Password reset email sent.';
  toast('Email sent');
}

async function signOut(){
  const { error } = await APP.sb.auth.signOut();
  if(error){
    toast('Could not sign out');
    console.warn(error);
    return;
  }
  APP.session = null;
  APP.me = null;
  APP.profileView.id = null;

  // close menu + refresh UI immediately (no refresh needed)
  byId('userMenu')?.classList.remove('open');
  renderAuthBits();
  toast('Signed out');
  showPage('home');
}

// boot
init().catch((e)=>{
  console.error(e);
  toast('App crashed. Open console for details.');
});