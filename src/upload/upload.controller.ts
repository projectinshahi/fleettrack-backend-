import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UploadService } from './upload.service';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadQueryDto } from './dto/upload-query.dto';

/** Express request with the JWT-authenticated user attached by the guards. */
interface AuthedRequest extends Request {
  user: { userId: string; role: string; accountType?: string };
}

/** The multer file fields we use (typed locally so no @types/multer is required). */
interface MulterFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
const ALLOWED_MIME = (
  process.env.UPLOAD_ALLOWED_MIME ??
  'image/png,image/jpeg,image/webp,application/pdf'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MIME_PATTERN = new RegExp(
  `^(${ALLOWED_MIME.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
    '|',
  )})$`,
);

/**
 * `inline` Content-Disposition that is always a valid header value: an ASCII fallback name
 * plus the RFC 5987 UTF-8 name. A raw non-Latin-1 filename (a Malayalam or Hindi receipt
 * title, say) is an invalid header value, so Node threw and the file could not be opened
 * (500); a quote in the name broke the parameter.
 */
export function contentDisposition(originalName: string): string {
  const fallback = originalName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(originalName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Shared upload API — file intake/serving for the whole app (receipts, POD, …).
 * Domain-agnostic: files are keyed by generic `category` + owning `tripId`; role rules
 * mirror the trips module (CLIENT writes its own trips' files, ADMIN reads). File bytes
 * are served through this authenticated endpoint (not a public URL); the frontend loads
 * them with its bearer token and renders via object URLs.
 */
@Controller('uploads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Roles('CLIENT')
  @Post()
  // Cap at the multer layer too, so oversized uploads abort before buffering fully.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  upload(
    @Req() req: AuthedRequest,
    @Body() dto: CreateUploadDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_BYTES }),
          new FileTypeValidator({ fileType: MIME_PATTERN }),
        ],
      }),
    )
    file: MulterFile,
  ) {
    // FileTypeValidator checks the file's magic bytes; this checks the Content-Type the
    // client DECLARED, which is what gets stored and served back. Without it a real PDF
    // body declared as text/html passed and was later returned as text/html (and opened as
    // a blob on the frontend origin): a stored-XSS path.
    if (!MIME_PATTERN.test(file.mimetype)) {
      throw new BadRequestException('Unsupported file type');
    }

    return this.uploadService.store(req.user, {
      tripId: dto.tripId,
      category: dto.category,
      costComponent: dto.costComponent,
      file: {
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
    });
  }

  @Roles('ADMIN', 'CLIENT')
  @Get()
  list(@Req() req: AuthedRequest, @Query() query: UploadQueryDto) {
    return this.uploadService.list(
      req.user,
      query.tripId,
      query.category,
      query.costComponent,
    );
  }

  @Roles('ADMIN', 'CLIENT')
  @Get('file/:key')
  async streamFile(
    @Req() req: AuthedRequest,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, mimeType, originalName } =
      await this.uploadService.getReadableFile(req.user, key);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': contentDisposition(originalName),
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(stream);
  }

  @Roles('CLIENT')
  @Delete(':id')
  remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.uploadService.remove(req.user, id);
  }
}
