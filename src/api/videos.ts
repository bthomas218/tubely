import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError } from "./errors";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";

const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new BadRequestError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const type = videoFile.type;
  if (type !== "video/mp4") {
    throw new BadRequestError("Unsupported file type");
  }

  console.log("uploading video: ", videoId, "by user", userID);

  const ext = ".mp4";
  const fileName = `${randomBytes(32).toString("hex")}${ext}`;
  const buffer = await videoFile.arrayBuffer();
  const file = Bun.file(path.join(cfg.assetsRoot, fileName));
  await Bun.write(file, buffer);

  //Upload to S3
  await cfg.s3Client.file(fileName).write(file, {
    type: type,
  });

  // Delete file when done
  await file.delete();

  //Update video url
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileName}`;

  updateVideo(cfg.db, video);
  const updatedVideo = getVideo(cfg.db, videoId);

  return respondWithJSON(200, updatedVideo);
}
