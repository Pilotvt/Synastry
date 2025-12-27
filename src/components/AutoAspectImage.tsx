import React, { useEffect, useMemo, useState } from 'react';

type AutoAspectImageProps = {
  src: string;
  alt: string;
  wrapperClassName?: string;
  imgClassName?: string;
  fallbackAspectRatio?: number;
  onError?: () => void;
};

const AutoAspectImage: React.FC<AutoAspectImageProps> = ({
  src,
  alt,
  wrapperClassName,
  imgClassName,
  fallbackAspectRatio = 1.5,
  onError,
}) => {
  const [aspectRatio, setAspectRatio] = useState<number>(fallbackAspectRatio);

  useEffect(() => {
    setAspectRatio(fallbackAspectRatio);
  }, [src, fallbackAspectRatio]);

  const wrapperStyle = useMemo(() => ({ aspectRatio }), [aspectRatio]);

  return (
    <div className={wrapperClassName} style={wrapperStyle}>
      <img
        src={src}
        alt={alt}
        className={['block h-full w-full', imgClassName ?? ''].filter(Boolean).join(' ')}
        onLoad={(e) => {
          const img = e.currentTarget;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (w > 0 && h > 0) {
            setAspectRatio(w / h);
          }
        }}
        onError={() => {
          if (typeof onError === 'function') onError();
        }}
      />
    </div>
  );
};

export default AutoAspectImage;

