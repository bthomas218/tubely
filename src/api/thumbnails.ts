import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { file, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

/* const videoThumbnails: Map<string, Thumbnail> = new Map(); */

/* export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
} */

const MAX_UPLOAD_SIZE = 10 << 20; //10MB

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const thumbnail = formData.get("thumbnail");

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }
  if (!["image/png", "image/jpeg"].includes(thumbnail.type)) {
    throw new BadRequestError(`Unsupported file type: ${thumbnail.type}`);
  }

  const type = thumbnail.type.split("/")[1];
  console.log("thumbnail type:", type);
  const buffer = await thumbnail.arrayBuffer();

  const video = getVideo(cfg.db, videoId);
  if (!video) throw new NotFoundError("Video not found");
  if (video.userID !== userID) throw new UserForbiddenError("Forbidden");

  /* videoThumbnails.set(video.id, {
    data: buffer,
    mediaType: type,
  }); */

  const fileName = randomBytes(32).toString("base64url");
  const file = Bun.file(path.join(cfg.assetsRoot, `${fileName}.${type}`));
  await Bun.write(file, buffer);

  const thumbnailUrl = `http://localhost:8091/assets/${fileName}.${type}`;
  console.log("thumbnail URL:", thumbnailUrl);
  video.thumbnailURL = thumbnailUrl;

  updateVideo(cfg.db, video);

  const updatedVideo = getVideo(cfg.db, video.id);
  return respondWithJSON(200, updatedVideo);
}
