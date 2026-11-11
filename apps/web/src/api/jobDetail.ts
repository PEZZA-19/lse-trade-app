import type {
  JobDetailDto,
  JobLineCreate,
  JobLineUpdate,
  JobNoteDto,
  JobPhotoDto,
  PhotoUpload,
  TimesheetCreate,
  TimesheetUpdate,
} from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './hooks';

/** Time and materials change the job, its costing and the reports. */
function useJobChange<V>(fn: (v: V) => Promise<JobDetailDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (j) => {
      qc.setQueryData(keys.job(j.id), j);
      for (const k of ['jobs', 'job-costing', 'reports', 'job-invoicing'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export const useAddTimesheet = () =>
  useJobChange(({ jobId, ...input }: TimesheetCreate & { jobId: string }) =>
    api<JobDetailDto>('POST', `/jobs/${jobId}/timesheets`, input),
  );
export const useUpdateTimesheet = () =>
  useJobChange(({ id, ...input }: TimesheetUpdate & { id: string }) =>
    api<JobDetailDto>('PATCH', `/timesheets/${id}`, input),
  );
export const useDeleteTimesheet = () =>
  useJobChange((id: string) => api<JobDetailDto>('DELETE', `/timesheets/${id}`));

export const useAddJobLine = () =>
  useJobChange(({ jobId, ...input }: JobLineCreate & { jobId: string }) =>
    api<JobDetailDto>('POST', `/jobs/${jobId}/lines`, input),
  );
export const useUpdateJobLine = () =>
  useJobChange(({ id, ...input }: JobLineUpdate & { id: string }) =>
    api<JobDetailDto>('PATCH', `/job-lines/${id}`, input),
  );
export const useDeleteJobLine = () =>
  useJobChange((id: string) => api<JobDetailDto>('DELETE', `/job-lines/${id}`));

export const useNotes = (jobId: string) =>
  useQuery({
    queryKey: ['job-notes', jobId],
    queryFn: () => api<JobNoteDto[]>('GET', `/jobs/${jobId}/notes`),
  });
export function useAddNote(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api<JobNoteDto[]>('POST', `/jobs/${jobId}/notes`, { body }),
    onSuccess: (n) => qc.setQueryData(['job-notes', jobId], n),
  });
}
export function useDeleteNote(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<JobNoteDto[]>('DELETE', `/notes/${id}`),
    onSuccess: (n) => qc.setQueryData(['job-notes', jobId], n),
  });
}

export const usePhotos = (jobId: string) =>
  useQuery({
    queryKey: ['job-photos', jobId],
    queryFn: () => api<JobPhotoDto[]>('GET', `/jobs/${jobId}/photos`),
  });
export function useAddPhoto(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PhotoUpload) => api<JobPhotoDto[]>('POST', `/jobs/${jobId}/photos`, input),
    onSuccess: (p) => qc.setQueryData(['job-photos', jobId], p),
  });
}
export function useDeletePhoto(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<JobPhotoDto[]>('DELETE', `/photos/${id}`),
    onSuccess: (p) => qc.setQueryData(['job-photos', jobId], p),
  });
}
