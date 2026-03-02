import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST() {
  (await cookies()).delete('bff_session');
  return NextResponse.json({ ok: true });
}
