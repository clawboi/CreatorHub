
const app = document.getElementById("app");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const modal = document.getElementById("authModal");

const sb = supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY,
  { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storage:localStorage }}
);

async function getUser(){
  const {data:{session}} = await sb.auth.getSession();
  return session?.user||null;
}

function show(page){
  if(page==="home") app.innerHTML="<h1>Home</h1>";
  if(page==="book") app.innerHTML="<h1>Book</h1>";
  if(page==="projects") app.innerHTML="<h1>Projects</h1>";
}

document.querySelectorAll("nav button[data-page]").forEach(b=>{
  b.onclick= async ()=>{
    const user = await getUser();
    if(!user){ modal.classList.remove("hidden"); return;}
    show(b.dataset.page);
  };
});

loginBtn.onclick=()=>modal.classList.remove("hidden");

document.getElementById("doLogin").onclick=async()=>{
  const email=emailInput.value;
  const password=passInput.value;
  const {error}=await sb.auth.signInWithPassword({email,password});
  if(error){alert(error.message);return;}
  modal.classList.add("hidden");
  init();
};

document.getElementById("doSignup").onclick=async()=>{
  const email=emailInput.value;
  const password=passInput.value;
  const {error}=await sb.auth.signUp({email,password});
  if(error){alert(error.message);return;}
  alert("account created");
};

logoutBtn.onclick=async()=>{
  await sb.auth.signOut();
  init();
};

async function init(){
  const user = await getUser();
  if(user){
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
  }else{
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
  }
  show("home");
}
init();
