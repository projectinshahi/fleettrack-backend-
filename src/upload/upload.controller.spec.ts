import { BadRequestException } from '@nestjs/common';

import { contentDisposition, UploadController } from './upload.controller';

describe('UploadController hardening', () => {
  const store = jest.fn().mockResolvedValue({ success: true });
  const controller = new UploadController({ store } as any);
  const req: any = { user: { userId: 'client-1', role: 'CLIENT' } };
  const dto: any = { tripId: 'trip-1', category: 'RECEIPT' };
  const file = (mimetype: string) => ({
    buffer: Buffer.from('%PDF-1.4'),
    originalname: 'receipt.pdf',
    mimetype,
    size: 8,
  });

  beforeEach(() => store.mockClear());

  it('rejects a file whose DECLARED type is not allowed, even when its bytes are', () => {
    expect(() => controller.upload(req, dto, file('text/html'))).toThrow(
      BadRequestException,
    );
    expect(store).not.toHaveBeenCalled();
  });

  it('stores a file whose declared type is allowed', async () => {
    await controller.upload(req, dto, file('application/pdf'));
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('builds a valid header value for a non-Latin-1 filename', () => {
    const header = contentDisposition('രസീത് "final".pdf');
    expect(header).toMatch(
      /^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''/,
    );
    // Every character must be printable ASCII, or Node rejects the header (a 500).
    expect(header).not.toMatch(/[^\x20-\x7e]/);
  });
});
