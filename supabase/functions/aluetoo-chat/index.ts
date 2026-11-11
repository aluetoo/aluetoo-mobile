import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODEL_LIMITS: Record<string, number> = {
  "fast-lite": 20, "super-fast": 10, "pro": 5,
};
const MODEL_NAMES: Record<string, string> = {
  "fast-lite": "openai/gpt-oss-20b",
  "super-fast": "qwen/qwen3.8-27b",
  "pro": "openai/gpt-oss-120b",
};
const SYSTEM_PROMPT =
  "Tu es ALUETOO AI. Réponds naturellement dans la langue de l'utilisateur. " +
  "Utilise le Markdown quand c'est utile : titres, listes, gras, italique, tableaux et blocs de code. " +
  "Pour afficher une image accessible, utilise ![Description de l'image](URL_DIRECTE_DE_L_IMAGE). " +
  "N'invente pas d'URL et ne prétends pas avoir généré une image sans outil disponible.";

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(500, { error: "server_configuration_error" });
  if (!groqKey) return jsonResponse(503, {
    error: "ai_provider_not_configured",
    message: "Le service IA doit être configuré par l'administrateur.",
  });

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return jsonResponse(401, { error: "missing_authentication" });

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse(401, { error: "invalid_session" });

  let payload: { modelKey?: string; messages?: unknown };
  try { payload = await req.json(); }
  catch { return jsonResponse(400, { error: "invalid_json" }); }

  const modelKey = payload.modelKey || "";
  if (!Object.prototype.hasOwnProperty.call(MODEL_LIMITS, modelKey)) return jsonResponse(400, { error: "invalid_model" });
  if (!Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > 50) {
    return jsonResponse(400, { error: "invalid_messages" });
  }

  const messages = payload.messages as Array<{ role?: string; content?: unknown }>;
  let totalChars = 0;
  for (const message of messages) {
    if (!message || !["user", "assistant"].includes(message.role || "")) {
      return jsonResponse(400, { error: "invalid_message_role" });
    }
    if (typeof message.content !== "string") return jsonResponse(400, { error: "unsupported_message_content" });
    totalChars += message.content.length;
    if (message.content.length > 24000 || totalChars > 60000) return jsonResponse(413, { error: "message_too_large" });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: quotaRows, error: quotaError } = await admin.rpc("aluetoo_consume_ai_quota", {
    p_user_id: authData.user.id,
    p_model_key: modelKey,
  });
  if (quotaError || !Array.isArray(quotaRows) || quotaRows.length !== 1) {
    console.error("Quota check failed:", quotaError?.message || "empty result");
    return jsonResponse(500, { error: "quota_check_failed" });
  }

  const quota = quotaRows[0];
  const quotaHeaders = {
    "X-Aluetoo-Quota-Model": modelKey,
    "X-Aluetoo-Quota-Used": String(quota.used),
    "X-Aluetoo-Quota-Limit": String(quota.quota_limit),
    "X-Aluetoo-Bonus-Remaining": String(quota.bonus_remaining),
    "X-Aluetoo-Quota-Reset": String(quota.reset_at),
  };
  if (!quota.allowed) {
    const banned = quota.reason === "banned";
    return jsonResponse(banned ? 403 : 429, {
      error: banned ? "account_banned" : "quota_exceeded",
      message: banned
        ? "Ce compte est temporairement bloqué. Contacte l'équipe Aluetoo si tu penses qu'il s'agit d'une erreur."
        : "La limite de messages pour ce modèle est atteinte. Réessaie après la réinitialisation.",
      quota,
    }, quotaHeaders);
  }

  const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAMES[modelKey],
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      temperature: 0.7,
      stream: true,
    }),
  });
  if (!groqResponse.ok || !groqResponse.body) {
    console.error("Groq provider returned:", groqResponse.status);
    return jsonResponse(502, { error: "ai_provider_error" }, quotaHeaders);
  }
  return new Response(groqResponse.body, {
    status: 200,
    headers: {
      ...corsHeaders, ...quotaHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
});
