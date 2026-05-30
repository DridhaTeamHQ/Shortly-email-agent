import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, json, requiredEnv } from "../_shared/http.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (request.method === "GET") {
    const { data, error } = await supabase
      .from("subscribers")
      .select("id,email,full_name,status,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ subscribers: data });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    if (action === "add") {
      const { email, full_name } = body;
      if (!email?.trim()) return json({ error: "email is required" }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = full_name?.trim() || null;
      const { data: existing, error: existingError } = await supabase
        .from("subscribers")
        .select("id,status,full_name")
        .eq("email", normalizedEmail)
        .maybeSingle();
      if (existingError) return json({ error: existingError.message }, 500);

      if (existing?.id) {
        const patch: Record<string, unknown> = {
          status: "subscribed",
          updated_at: new Date().toISOString()
        };
        if (normalizedName) patch.full_name = normalizedName;
        const { error } = await supabase
          .from("subscribers")
          .update(patch)
          .eq("id", existing.id);
        if (error) return json({ error: error.message }, 400);
        return json({
          ok: true,
          existing: true,
          resubscribed: existing.status !== "subscribed"
        });
      }

      const { error } = await supabase
        .from("subscribers")
        .insert({ email: normalizedEmail, full_name: normalizedName });
      if (error) return json({ error: error.message }, 400);

      return json({ ok: true, created: true });
    }

    if (action === "update") {
      const { id, status } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) return json({ error: "id is required" }, 400);
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
});
