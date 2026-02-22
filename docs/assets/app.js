
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
  book: { category:null, service:null, budget:200 },
  pendingRequest: null, // {packageId}
  feedMode: 'all',
};

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
    const nav = t?.dataset?.nav;
    if(nav){
      e.preventDefault();

      // Auth-gated pages
      if((nav === 'create' || nav === 'projects' || nav === 'profile') && !APP.session?.user){
        toast('Sign in to continue');
        showPage('signin');
        return;
      }
      showPage(nav);
      return;
    }

    // feed toggle
    const feedMode = t?.dataset?.feed;
    if(feedMode){
      APP.feedMode = feedMode;
      $$('.segbtn').forEach(b => b.classList.toggle('is-on', b.dataset.feed === feedMode));
      loadFeed().catch(()=>{});
      return;
    }

    // chips
    const cat = t?.dataset?.cat;
    if(cat){
      APP.book.category = cat;
      APP.book.service = null;
      renderBook().catch(()=>{});
      return;
    }
    const svc = t?.dataset?.svc;
    if(svc){
      APP.book.service = svc;
      renderBook().catch(()=>{});
      return;
    }

    // request package
    const req = t?.dataset?.request;
    if(req){
      e.preventDefault();
      openRequestForPackage(req).catch(()=>{});
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

  // Create
  byId('btnCreatePackage')?.addEventListener('click', ()=> createPackage().catch(()=>{}));
  byId('cCategory')?.addEventListener('change', ()=> syncCreateServices());
  // Profile
  byId('btnSaveProfile')?.addEventListener('click', ()=> saveProfile().catch(()=>{}));

  // Auth
  byId('btnDoSignIn')?.addEventListener('click', ()=> signIn().catch(()=>{}));
  byId('btnDoSignUp')?.addEventListener('click', ()=> signUp().catch(()=>{}));
  byId('btnShowSignUp')?.addEventListener('click', ()=> byId('signupBox').classList.toggle('hidden'));
  byId('btnForgot')?.addEventListener('click', ()=> forgotPassword().catch(()=>{}));
  byId('btnSignOut')?.addEventListener('click', ()=> signOut().catch(()=>{}));

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
  const uid = APP.session.user.id;

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
}

async function renderBook(){
  const cats = window.CREATOR_HUB_DATA.categories;
  const catWrap = byId('bookCategories');
  const svcWrap = byId('bookServices');

  if(catWrap){
    catWrap.innerHTML = cats.map(c => {
      const on = (APP.book.category || cats[0].id) === c.id;
      return `<button class="chip ${on?'is-on':''}" data-cat="${esc(c.id)}">${esc(c.label)}</button>`;
    }).join('');
  }

  const chosenCatId = APP.book.category || cats[0].id;
  const chosen = cats.find(c => c.id === chosenCatId) || cats[0];
  if(svcWrap){
    svcWrap.innerHTML = chosen.services.map(s => {
      const on = APP.book.service === s;
      return `<button class="chip ${on?'is-on':''}" data-svc="${esc(s)}">${esc(s)}</button>`;
    }).join('');
  }

  // Hint
  byId('matchHint').textContent = (APP.book.service)
    ? `Searching: ${chosen.label} • ${APP.book.service} • Budget $${APP.book.budget}`
    : 'Select a service, then click Find matches.';

  // if we already have matches loaded and service changed, clear
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
        <div class="sub">${esc(chosen.label)} • ${esc(p.service)} • ${esc(name)} • ${esc(p.delivery_days)} day delivery</div>
        <div class="row">
          <div class="price">$${esc(usdFromCents(p.price_cents))}</div>
          <button class="btn tiny" data-request="${esc(p.id)}">Request</button>
        </div>
      </div>
    `;
  }).join('');
}

async function openRequestForPackage(packageId){
  // Must be signed in to create booking
  if(!APP.session?.user){
    APP.pendingRequest = { packageId };
    toast('Sign in to send a request');
    showPage('signin');
    return;
  }

  const { data, error } = await APP.sb
    .from('packages')
    .select('id,title,service,category,price_cents,delivery_days,owner,profiles:owner(username)')
    .eq('id', packageId)
    .maybeSingle();

  if(error || !data){
    toast('Package not found');
    return;
  }

  const creator = data.profiles?.username ? `@${data.profiles.username}` : 'creator';
  const budget = Number(byId('budget')?.value || APP.book.budget || 200);

  openModal('Request project', `
    <div class="muted" style="margin-bottom:10px;">
      <b>${esc(data.title || data.service)}</b><br/>
      ${esc(data.category)} • ${esc(data.service)} • ${esc(creator)}<br/>
      Base: $${esc(usdFromCents(data.price_cents))} • Delivery: ${esc(data.delivery_days)} days
    </div>

    <label>Budget (USD)</label>
    <input id="rqBudget" class="input" type="number" min="10" step="10" value="${esc(budget)}"/>

    <label>Message</label>
    <textarea id="rqMsg" class="input area" placeholder="Tell them what you need, vibe, location, deadline..."></textarea>

    <div class="row between">
      <button class="btn ghost" id="rqCancel">Cancel</button>
      <button class="btn" id="rqSend">Send request</button>
    </div>
  `);

  byId('rqCancel')?.addEventListener('click', closeModal);
  byId('rqSend')?.addEventListener('click', async ()=>{
    const rqBudget = centsFromUsd(byId('rqBudget').value);
    const rqMsg = byId('rqMsg').value || '';
    const { error: insErr } = await APP.sb.from('bookings').insert({
      package_id: data.id,
      requester: APP.session.user.id,
      creator: data.owner,
      status: 'requested',
      budget_cents: rqBudget,
      message: rqMsg
    });
    if(insErr){
      console.warn(insErr);
      toast('Could not send request (check RLS).');
      return;
    }
    closeModal();
    toast('Request sent');
    showPage('projects');
    await loadProjects();
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

  const cat = byId('cCategory').value;
  const svc = byId('cService').value;
  const title = byId('cTitle').value.trim();
  const equipment = byId('cEquipment').value.trim();
  const delivery = Number(byId('cDelivery').value || 7);
  const priceUsd = Number(byId('cPrice').value || 0);
  const included = byId('cIncluded').value.trim();
  const addonsRaw = (byId('cAddons').value || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const images = (byId('cImages').value || '').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,4);
  const video = (byId('cVideo').value || '').trim();

  if(!title){
    toast('Add a title');
    return;
  }
  if(priceUsd < 10){
    toast('Set a price (at least $10)');
    return;
  }

  const payload = {
    owner: APP.session.user.id,
    category: cat,
    service: svc,
    title,
    equipment,
    delivery_days: Math.max(1, delivery|0),
    included,
    addons: addonsRaw.map(x => ({ label:x })),
    price_cents: centsFromUsd(priceUsd),
    image_urls: images.length ? images : null,
    video_url: video || null,
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
    const { data: following, error: fErr } = await APP.sb.from('follows').select('following').eq('follower', uid);
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

async function loadProfile(){
  if(!APP.session?.user) return;
  byId('pUsername').value = APP.me?.username || '';
  byId('pBio').value = APP.me?.bio || '';
  byId('pAvatar').value = APP.me?.avatar_url || '';
  byId('pReel').value = APP.me?.featured_reel_url || '';
}

async function saveProfile(){
  if(!APP.session?.user) return;
  const status = byId('profileStatus');
  status.textContent = '';

  const payload = {
    username: (byId('pUsername').value || '').trim() || null,
    bio: (byId('pBio').value || '').trim() || null,
    avatar_url: (byId('pAvatar').value || '').trim() || null,
    featured_reel_url: (byId('pReel').value || '').trim() || null,
  };

  const { error } = await APP.sb.from('profiles').update(payload).eq('id', APP.session.user.id);
  if(error){
    console.warn(error);
    status.textContent = error.message;
    toast('Could not save profile');
    return;
  }
  status.textContent = 'Saved.';
  toast('Saved');
  await hydrateProfile();
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
  APP.me = null;
  toast('Signed out');
  showPage('home');
}

// boot
init().catch((e)=>{
  console.error(e);
  toast('App crashed. Open console for details.');
});
