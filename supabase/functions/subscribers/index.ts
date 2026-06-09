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
      .select("id,email,full_name,phone_number,status,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ subscribers: data });
  }

  if (request.method === "POST") {
    const body = await request.json();
    const { action } = body;

    if (action === "add") {
      const { email, full_name, phone_number } = body;
      if (!email?.trim()) return json({ error: "email is required" }, 400);
      const normalizedEmail = email.trim().toLowerCase();
      const normalizedName = full_name?.trim() || null;
      const normalizedPhone = phone_number?.trim() || null;
      const { data: existing, error: existingError } = await supabase
        .from("subscribers")
        .select("id,status,full_name,phone_number")
        .eq("email", normalizedEmail)
        .maybeSingle();
      if (existingError) return json({ error: existingError.message }, 500);

      if (existing?.id) {
        const patch: Record<string, unknown> = {
          status: "subscribed",
          updated_at: new Date().toISOString()
        };
        if (normalizedName) patch.full_name = normalizedName;
        if (normalizedPhone) patch.phone_number = normalizedPhone;
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
        .insert({ email: normalizedEmail, full_name: normalizedName, phone_number: normalizedPhone });
      if (error) return json({ error: error.message }, 400);

      return json({ ok: true, created: true });
    }

    if (action === "import") {
      const rows = Array.isArray(body.subscribers) ? body.subscribers : [];
      const updatedAt = new Date().toISOString();
      const normalizedByEmail = new Map<string, Record<string, string | null>>();
      for (const row of rows) {
        const normalized = {
          email: row?.email?.trim()?.toLowerCase() || "",
          full_name: row?.full_name?.trim() || null,
          phone_number: row?.phone_number?.trim() || null,
          status: "subscribed",
          updated_at: updatedAt
        };
        if (normalized.email) {
          normalizedByEmail.set(normalized.email, normalized);
        }
      }
      const normalizedRows = Array.from(normalizedByEmail.values());

      if (normalizedRows.length === 0) {
        return json({ error: "No valid subscribers found in CSV" }, 400);
      }

      const { error } = await supabase
        .from("subscribers")
        .upsert(normalizedRows, { onConflict: "email" });
      if (error) return json({ error: error.message, code: error.code, details: error.details }, 400);

      return json({ ok: true, imported: normalizedRows.length });
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
