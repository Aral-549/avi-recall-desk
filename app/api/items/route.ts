import { NextResponse } from "next/server";
import { saveItem } from "@/lib/db/sqlite";
import type { Item } from "@/lib/avi/types";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { item?: Item };
    if (!body || !body.item) {
      return NextResponse.json({ ok: false, error: "Missing item payload" }, { status: 400 });
    }
    saveItem(body.item);
    return NextResponse.json({ ok: true, item: body.item }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
