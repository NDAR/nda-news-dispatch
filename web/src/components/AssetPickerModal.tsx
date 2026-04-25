import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  createAsset,
  deleteAsset,
  listAssets,
  uploadAsset,
  type Asset,
} from '../api/endpoints';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export function AssetPickerModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (asset: Asset) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['assets'],
    queryFn: listAssets,
  });
  const assets = data?.items ?? [];

  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      // Three steps: ask the API for a presigned URL + meta record, PUT
      // the bytes directly to S3, then surface the new asset row.
      const meta = await createAsset({
        filename: file.name,
        contentType: file.type,
        size: file.size,
      });
      await uploadAsset(meta.uploadUrl, file);
      return {
        id: meta.id,
        filename: file.name,
        contentType: meta.contentType,
        size: file.size,
        key: meta.key,
        url: meta.url,
        createdAt: new Date().toISOString(),
      } as Asset;
    },
    onSuccess: (asset) => {
      qc.setQueryData<{ items: Asset[] }>(['assets'], (prev) => ({
        items: [asset, ...(prev?.items ?? [])],
      }));
      // Auto-select the just-uploaded asset so the user can click straight
      // through to the editor.
      onSelect(asset);
    },
    onError: (e) => setUploadError(e instanceof Error ? e.message : String(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteAsset(id),
    onSuccess: (_, id) => {
      qc.setQueryData<{ items: Asset[] }>(['assets'], (prev) => ({
        items: (prev?.items ?? []).filter((a) => a.id !== id),
      }));
    },
  });

  const accept = (file: File | null | undefined) => {
    setUploadError(null);
    if (!file) return;
    if (!ALLOWED_TYPES.has(file.type)) {
      setUploadError(`Unsupported file type: ${file.type || '(unknown)'}. JPEG, PNG, GIF, WebP only.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    uploadMut.mutate(file);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Assets</div>
            <h3 className="serif mt-sm">Insert image</h3>
          </div>
        </div>
        <div className="modal-body stack" style={{ gap: 16 }}>
          <div
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              accept(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            style={{
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule)'}`,
              borderRadius: 8,
              padding: '20px',
              textAlign: 'center',
              cursor: uploadMut.isPending ? 'wait' : 'pointer',
              background: dragOver
                ? 'oklch(from var(--accent) l c h / 0.06)'
                : 'var(--paper-deep)',
              transition: 'all 0.12s',
              opacity: uploadMut.isPending ? 0.6 : 1,
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              hidden
              disabled={uploadMut.isPending}
              onChange={(e) => {
                accept(e.target.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
            {uploadMut.isPending ? (
              <div className="muted serif" style={{ fontSize: 14 }}>Uploading…</div>
            ) : (
              <>
                <div className="serif" style={{ fontSize: 14 }}>
                  Drop an image here or{' '}
                  <span style={{ color: 'var(--accent-deep)', textDecoration: 'underline' }}>
                    click to browse
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                  JPEG, PNG, GIF, WebP · up to {MAX_BYTES / 1024 / 1024} MB
                </div>
              </>
            )}
          </div>
          {uploadError && (
            <div style={{ color: 'var(--bad)', fontSize: 12 }}>{uploadError}</div>
          )}

          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              {isLoading
                ? 'Loading library…'
                : assets.length === 0
                  ? 'Library (empty)'
                  : `Library (${assets.length})`}
            </div>
            {error && (
              <div style={{ color: 'var(--bad)', fontSize: 12 }}>
                Failed to load assets: {(error as Error).message}
              </div>
            )}
            {assets.length === 0 && !isLoading && !error && (
              <div className="muted" style={{ fontSize: 12 }}>
                No assets yet. Upload an image above to add one.
              </div>
            )}
            {assets.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                  gap: 10,
                  maxHeight: 360,
                  overflow: 'auto',
                }}
              >
                {assets.map((a) => (
                  <AssetTile
                    key={a.id}
                    asset={a}
                    onClick={() => onSelect(a)}
                    onDelete={() => {
                      if (confirm(`Delete "${a.filename}"? Newsletters that already reference it will break.`)) {
                        deleteMut.mutate(a.id);
                      }
                    }}
                    deleting={deleteMut.isPending && deleteMut.variables === a.id}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={uploadMut.isPending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AssetTile({
  asset,
  onClick,
  onDelete,
  deleting,
}: {
  asset: Asset;
  onClick: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--rule)',
        borderRadius: 6,
        background: 'var(--paper)',
        overflow: 'hidden',
        cursor: 'pointer',
        opacity: deleting ? 0.4 : 1,
        transition: 'all 0.12s',
      }}
      onClick={onClick}
      title={`Insert ${asset.filename}`}
    >
      <div
        style={{
          width: '100%',
          aspectRatio: '4 / 3',
          background: `var(--paper-deep) url(${JSON.stringify(asset.url)}) center/contain no-repeat`,
        }}
      />
      <div style={{ padding: '6px 8px', fontSize: 11 }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={asset.filename}
        >
          {asset.filename}
        </div>
        {asset.size !== undefined && (
          <div className="muted" style={{ fontSize: 10, marginTop: 1 }}>
            {(asset.size / 1024).toFixed(1)} KB
          </div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete"
        disabled={deleting}
        style={{
          position: 'absolute',
          top: 4,
          right: 4,
          width: 22,
          height: 22,
          borderRadius: 4,
          border: 'none',
          background: 'rgba(0,0,0,0.55)',
          color: 'var(--paper)',
          fontSize: 12,
          lineHeight: 1,
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
