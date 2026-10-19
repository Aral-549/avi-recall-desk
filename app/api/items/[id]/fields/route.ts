import { NextResponse } from "next/server";
import { updateItemField } from "@/lib/db/sqlite";
import type { Field, FieldName } from "@/lib/avi/types";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { name?: FieldName; field?: Field<unknown> };
    if (!body || !body.name || !body.field) {
      return NextResponse.json({ ok: false, error: "Missing name or field payload" }, { status: 400 });
    }
    updateItemField(id, body.name, body.field);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
