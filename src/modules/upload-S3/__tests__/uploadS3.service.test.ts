import { isProtectedKey, UploadS3Error, UploadS3Service } from '../uploadS3.service';

describe('UploadS3Service.deleteUnprotected (DELETE /upload-s3)', () => {
  let service: UploadS3Service;
  let deleteSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new UploadS3Service({} as never);
    deleteSpy = jest.spyOn(service, 'delete').mockResolvedValue({ deleted: true });
  });

  it.each(['certifications/farm/c1/doc.pdf', '/certifications/farm/c1/doc.pdf', '  certifications/x'])(
    'recusa com 403 arquivos de certificação (%s)',
    async (key) => {
      const err = await service.deleteUnprotected(key).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadS3Error);
      expect((err as UploadS3Error).status).toBe(403);
      expect(deleteSpy).not.toHaveBeenCalled();
    }
  );

  it('apaga arquivos comuns', async () => {
    await expect(service.deleteUnprotected('abc-123-foto.png')).resolves.toEqual({ deleted: true });
    expect(deleteSpy).toHaveBeenCalledWith('abc-123-foto.png');
  });

  it('não confunde nomes que só contêm a palavra', () => {
    expect(isProtectedKey('uuid-certifications-scan.pdf')).toBe(false);
    expect(isProtectedKey('produtos/certifications/x.png')).toBe(false);
  });
});
