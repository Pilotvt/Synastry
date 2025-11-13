import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";

type ProfileData = {
  mainPhoto?: string | null;
  smallPhotos?: (string | null)[];
  [key: string]: unknown;
};

const EMPTY_SMALL_PHOTOS: (string | null)[] = [null, null];

const PhotoView: React.FC = () => {
  const { userId, idx } = useParams<{ userId: string; idx: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase.from("profiles").select("data").eq("id", userId).single();
        if (error) throw error;
        if (!cancelled) setProfile((data?.data ?? null) as ProfileData | null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading) return <div className="min-h-screen flex items-center justify-center">����㧪�...</div>;
  if (error) return <div className="min-h-screen flex items-center justify-center">�訡��: {error}</div>;
  if (!profile) return <div className="min-h-screen flex items-center justify-center">��䨫� �� ������</div>;

  const index = Number(idx ?? 0);
  // index 0 -> mainPhoto, 1/2 -> smallPhotos indexes
  const src = index === 0 ? profile.mainPhoto : (profile.smallPhotos && profile.smallPhotos[index - 1]) || null;

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const result = ev.target?.result ?? null;
      if (typeof result !== "string") return;
      try {
        // update profile data
        const newProfile: ProfileData = { ...(profile ?? {}) };
        if (index === 0) newProfile.mainPhoto = result;
        else {
          const arr = Array.isArray(newProfile.smallPhotos)
            ? [...newProfile.smallPhotos]
            : [...EMPTY_SMALL_PHOTOS];
          arr[index - 1] = result;
          newProfile.smallPhotos = arr;
        }
        const payload = { id: userId, data: newProfile };
        const { error } = await supabase.from("profiles").upsert(payload);
        if (error) throw error;
        setProfile(newProfile);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white/5 rounded p-4">
        <div className="flex justify-between items-center mb-4">
          <button onClick={() => navigate("/questionnaire")} className="px-3 py-1 rounded bg-gray-700"> �����</button>
          <div className="text-sm text-white/70">��ᬮ�� ��</div>
          <div />
        </div>
        <div className="flex flex-col items-center gap-4">
          {src ? (
            <img src={src} alt="���" className="max-w-full max-h-[70vh] object-contain rounded" />
          ) : (
            <div className="w-full h-80 bg-gray-700 flex items-center justify-center">��� ��</div>
          )}

          <div className="flex gap-3">
            <label className="px-3 py-1 bg-blue-600 rounded cursor-pointer">
              ������஢���
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </label>
            <button onClick={() => navigate("/questionnaire")} className="px-3 py-1 bg-gray-700 rounded">�����</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PhotoView;
