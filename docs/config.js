/* CreatorHub config.js
   IMPORTANT:
   - Put ONLY your Supabase Project URL and ANON key here.
   - Do NOT put the service_role / secret key in any frontend file.
*/
window.SUPABASE_URL = window.SUPABASE_URL || "https://tvxsvxujpuvknkyruwhw.supabase.co";
window.SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2eHN2eHVqcHV2a25reXJ1d2h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1NDUwNzgsImV4cCI6MjA4NzEyMTA3OH0.ViCZJVeeG2C6VtiF1mOB1Jh-F_s_XXfFxEDJyVWDMi4";

// Optional: GitHub Pages base path helper (index.html also sets this)
window.CREATORHUB_BASE = window.CREATORHUB_BASE || (function(){
  const p = location.pathname || "/";
  const parts = p.split("/").filter(Boolean);
  return (parts.length ? ("/" + parts[0] + "/") : "/");
})();

// Build tag
window.CREATORHUB_BUILD = window.CREATORHUB_BUILD || "replacement-v10";
