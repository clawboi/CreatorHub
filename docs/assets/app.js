const app=document.getElementById("app");
const loginBtn=document.getElementById("loginBtn");
const logoutBtn=document.getElementById("logoutBtn");
const modal=document.getElementById("authModal");

const sb=supabase.createClient(window.SUPABASE_URL,window.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:localStorage}});

async function user(){const{data:{session}}=await sb.auth.getSession();return session?.user||null;}

function page(name){
if(name==="home")app.innerHTML="<h1>Welcome to CreatorHub</h1>";
if(name==="book")app.innerHTML="<h1>Book a Creator</h1>";
if(name==="projects")app.innerHTML="<h1>Your Projects</h1>";
}

document.querySelectorAll("nav button[data-page]").forEach(b=>{
b.onclick=async()=>{if(!await user()){modal.classList.remove("hidden");return;}page(b.dataset.page);};
});

loginBtn.onclick=()=>modal.classList.remove("hidden");

doLogin.onclick=async()=>{
const{error}=await sb.auth.signInWithPassword({email:email.value,password:pass.value});
if(error)return alert(error.message);
modal.classList.add("hidden");
init();
};

doSignup.onclick=async()=>{
const{error}=await sb.auth.signUp({email:email.value,password:pass.value});
if(error)return alert(error.message);
alert("Account created");
};

logoutBtn.onclick=async()=>{await sb.auth.signOut();init();};

async function init(){
if(await user()){loginBtn.classList.add("hidden");logoutBtn.classList.remove("hidden");}
else{loginBtn.classList.remove("hidden");logoutBtn.classList.add("hidden");}
page("home");
}
init();