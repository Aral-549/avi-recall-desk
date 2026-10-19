import { NextResponse } from "next/server";
import { getAppData, saveAppData } from "@/lib/db/sqlite";
import type { AppData } from "@/lib/avi/types";

export async function GET() {
  try {
    const data = getAppData();
    return NextResponse.json({ ok: true, data });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { data?: AppData };
    if (!body || !body.data) {
      return NextResponse.json({ ok: false, error: "Missing data payload" }, { status: 400 });
    }
    saveAppData(body.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
