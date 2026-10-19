import { NextResponse } from "next/server";
import { getHealth } from "@/lib/db/sqlite";

export async function GET() {
  try {
    const health = getHealth();
    return NextResponse.json(health);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
