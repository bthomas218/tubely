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
  const filePath = path.join(cfg.assetsRoot, fileName);
  const file = Bun.file(filePath);
  await Bun.write(file, buffer);

  const aspectRatio = await getVideoAspectRatio(filePath);
  const processedFilePath = await processVideoForFastStart(filePath);
  const processedFile = Bun.file(processedFilePath);

  //Upload to S3
  await cfg.s3Client.file(`${aspectRatio}/${fileName}`).write(processedFile, {
    type: type,
  });

  // Delete file when done
  await file.delete();
  await processedFile.delete();

  //Update video url
  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${aspectRatio}/${fileName}`;

  updateVideo(cfg.db, video);
  const updatedVideo = getVideo(cfg.db, videoId);

  return respondWithJSON(200, updatedVideo);
}

async function getVideoAspectRatio(
  filePath: string
): Promise<"landscape" | "portrait" | "other"> {
  const proc = Bun.spawn({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      "-show_streams",
      filePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`Failed to get video info: ${error}`);
  }
  const output = (await new Response(proc.stdout).json()) as StreamInfo;
  const height = output.streams[0].height;
  const width = output.streams[0].width;
  if (!height || !width) {
    throw new Error("Failed to get video dimensions");
  }

  const aspectRatio = width / height;
  switch (true) {
    case aspectRatio >= 1.7:
      return "landscape";
    case aspectRatio <= 0.6:
      return "portrait";
    default:
      return "other";
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`Failed to process video: ${error}`);
  }

  return outputFilePath;
}

type StreamInfo = {
  programs: Array<any>;
  streams: Array<{
    index: number;
    codec_name: string;
    codec_long_name: string;
    profile: string;
    codec_type: string;
    codec_tag_string: string;
    codec_tag: string;
    width: number;
    height: number;
    coded_width: number;
    coded_height: number;
    closed_captions: number;
    film_grain: number;
    has_b_frames: number;
    sample_aspect_ratio: string;
    display_aspect_ratio: string;
    pix_fmt: string;
    level: number;
    color_range: string;
    color_space: string;
    color_transfer: string;
    color_primaries: string;
    chroma_location: string;
    field_order: string;
    refs: number;
    is_avc: string;
    nal_length_size: string;
    id: string;
    r_frame_rate: string;
    avg_frame_rate: string;
    time_base: string;
    start_pts: number;
    start_time: string;
    duration_ts: number;
    duration: string;
    bit_rate: string;
    bits_per_raw_sample: string;
    nb_frames: string;
    extradata_size: number;
    disposition: {
      default: number;
      dub: number;
      original: number;
      comment: number;
      lyrics: number;
      karaoke: number;
      forced: number;
      hearing_impaired: number;
      visual_impaired: number;
      clean_effects: number;
      attached_pic: number;
      timed_thumbnails: number;
      non_diegetic: number;
      captions: number;
      descriptions: number;
      metadata: number;
      dependent: number;
      still_image: number;
    };
    tags: {
      language: string;
      handler_name: string;
      vendor_id: string;
      encoder: string;
      timecode: string;
    };
  }>;
};
