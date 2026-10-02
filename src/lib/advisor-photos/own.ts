/**
 * The signed in person's own picture, for the account menu in both layouts
 * (#3027). Through the one resolver like every other surface, so the face in the
 * header is the face on the roster.
 */
import { log } from "@/lib/log";
import { loadPhotoRecords } from "@/lib/advisor-photos/store";
import { photoSrc, resolveAdvisorPhoto, type PhotoRecord } from "@/lib/advisor-photos/resolve";

export async function staffPhotoSrc(user: { id: string; avatar_url: string | null }): Promise<string | null> {
  let records: Map<string, PhotoRecord> | null = null;
  try {
    records = await loadPhotoRecords([user.id]);
  } catch (err) {
    // The resolver's unreadable state keeps the sign in photo; the header never
    // fails a page over a picture.
    log.warn("advisor-photos", { msg: "own photo unreadable, using the sign in photo" }, err);
  }
  return photoSrc(resolveAdvisorPhoto(user, records));
}
