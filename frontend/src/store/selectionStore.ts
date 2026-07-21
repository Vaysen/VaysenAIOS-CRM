import { create } from 'zustand';

interface SelectionState {
  selectedLeadIds: Set<string>;
  selectAllAcrossPages: boolean;
  totalLeads: number;

  toggleSelect: (id: string) => void;
  selectAllOnPage: (ids: string[]) => void;
  deselectAllOnPage: (ids: string[]) => void;
  setSelectAllAcrossPages: (value: boolean, totalLeads: number) => void;
  clearSelection: () => void;
  isSelected: (id: string) => boolean;
  getSelectedCount: () => number;
  getSelectedIds: () => string[];
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selectedLeadIds: new Set<string>(),
  selectAllAcrossPages: false,
  totalLeads: 0,

  toggleSelect: (id: string) => {
    set((state) => {
      const next = new Set(state.selectedLeadIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return {
        selectedLeadIds: next,
        selectAllAcrossPages: false,
      };
    });
  },

  selectAllOnPage: (ids: string[]) => {
    set((state) => {
      const next = new Set(state.selectedLeadIds);
      ids.forEach((id) => next.add(id));
      return {
        selectedLeadIds: next,
        selectAllAcrossPages: false,
      };
    });
  },

  deselectAllOnPage: (ids: string[]) => {
    set((state) => {
      const next = new Set(state.selectedLeadIds);
      ids.forEach((id) => next.delete(id));
      return {
        selectedLeadIds: next,
        selectAllAcrossPages: false,
      };
    });
  },

  setSelectAllAcrossPages: (value: boolean, totalLeads: number) => {
    set({
      selectAllAcrossPages: value,
      totalLeads,
      selectedLeadIds: value ? new Set() : new Set(),
    });
  },

  clearSelection: () => {
    set({
      selectedLeadIds: new Set(),
      selectAllAcrossPages: false,
    });
  },

  isSelected: (id: string) => {
    const state = get();
    return state.selectAllAcrossPages || state.selectedLeadIds.has(id);
  },

  getSelectedCount: () => {
    const state = get();
    if (state.selectAllAcrossPages) return state.totalLeads;
    return state.selectedLeadIds.size;
  },

  getSelectedIds: () => {
    const state = get();
    return Array.from(state.selectedLeadIds);
  },
}));
