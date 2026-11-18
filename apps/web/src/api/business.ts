import type {
  BankImportResultDto,
  BankLineExpense,
  BankMatchKind,
  BankTransactionDto,
  BillPaymentCreate,
  BillPaymentDto,
  BudgetUpdate,
  BusinessDto,
  ExpenseCreate,
  ExpenseDto,
  OpeningBalanceUpdate,
} from '@lse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, newIdempotencyKey } from './client';

export const businessKey = ['business'] as const;

/** The books behind the business overview and every Xero-style report (one fetch). */
export const useBusiness = (enabled = true) =>
  useQuery({
    queryKey: businessKey,
    queryFn: () => api<BusinessDto>('GET', '/business'),
    enabled,
  });

export function useSetOpening() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpeningBalanceUpdate) =>
      api<BusinessDto>('PUT', '/business/opening', input),
    onSuccess: (d) => qc.setQueryData(businessKey, d),
  });
}

export function useSetBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BudgetUpdate) => api<BusinessDto>('PUT', '/business/budget', input),
    onSuccess: (d) => qc.setQueryData(businessKey, d),
  });
}

export const billPaymentsKey = (id: string) => ['bill-payments', id] as const;
export const useBillPayments = (id: string, enabled = true) =>
  useQuery({
    queryKey: billPaymentsKey(id),
    queryFn: () => api<BillPaymentDto[]>('GET', `/supplier-bills/${id}/payments`),
    enabled,
  });

export function useRecordBillPayment(id: string) {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: BillPaymentCreate) =>
      api<BillPaymentDto[]>('POST', `/supplier-bills/${id}/payments`, input, {
        idempotencyKey: key,
      }),
    onSuccess: (rows) => {
      setKey(newIdempotencyKey());
      qc.setQueryData(billPaymentsKey(id), rows);
      void qc.invalidateQueries({ queryKey: businessKey });
    },
  });
}

/* ------------------------------ expenses and wages ------------------------------ */

export const expensesKey = ['expenses'] as const;
export const useExpenses = (enabled = true) =>
  useQuery({
    queryKey: expensesKey,
    queryFn: () => api<ExpenseDto[]>('GET', '/expenses'),
    enabled,
  });

export function useAddExpense() {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  return useMutation({
    mutationFn: (input: ExpenseCreate) =>
      api<ExpenseDto>('POST', '/expenses', input, { idempotencyKey: key }),
    onSuccess: () => {
      setKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: expensesKey });
      void qc.invalidateQueries({ queryKey: businessKey });
    },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<null>('DELETE', `/expenses/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: expensesKey });
      void qc.invalidateQueries({ queryKey: businessKey });
    },
  });
}

/* ----------------------------- bank statements ----------------------------- */

const bankKey = ['bank'] as const;

export const useBankLines = (status: 'unmatched' | 'matched' | 'ignored' | 'all', enabled = true) =>
  useQuery({
    queryKey: [...bankKey, status],
    queryFn: () => api<BankTransactionDto[]>('GET', `/bank/transactions?status=${status}`),
    enabled,
  });

export function useImportStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileName: string; csv: string }) =>
      api<BankImportResultDto>('POST', '/bank/imports', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bankKey }),
  });
}

export function useBankLineAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      a:
        | { id: string; match: { kind: BankMatchKind; id: string } }
        | { id: string; status: 'unmatched' | 'ignored' },
    ) =>
      'match' in a
        ? api<null>('POST', `/bank/transactions/${a.id}/match`, a.match)
        : api<null>('PUT', `/bank/transactions/${a.id}/status`, { status: a.status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bankKey }),
  });
}

/** Money out on the bank recorded as an expense and matched in one go. */
export function usePaymentFromBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, invoiceId }: { id: string; invoiceId: string }) =>
      api<{ invoiceId: string; paymentId: string; jobCompleted: boolean }>(
        'POST',
        `/bank/transactions/${id}/payment`,
        { invoiceId },
      ),
    onSuccess: () => {
      // Payments touch invoices, jobs and the books: refresh everything.
      void qc.invalidateQueries();
    },
  });
}

export function useBillPaymentFromBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, billId }: { id: string; billId: string }) =>
      api<{ billId: string; paymentId: string }>('POST', `/bank/transactions/${id}/bill-payment`, {
        billId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });
}

export function useExpenseFromBankLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Omit<BankLineExpense, never>) =>
      api<ExpenseDto>('POST', `/bank/transactions/${id}/expense`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankKey });
      void qc.invalidateQueries({ queryKey: expensesKey });
      void qc.invalidateQueries({ queryKey: businessKey });
    },
  });
}
