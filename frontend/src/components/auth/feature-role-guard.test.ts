import { createElement, useEffect, type ComponentType, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { canAccessProtectedModule, FeatureRoleGuard } from './feature-role-guard';

const companyId = 'company-1';
const TestableFeatureRoleGuard = FeatureRoleGuard as ComponentType<{
  module: 'customerFactsReview' | 'salesSequencesManagement';
  children?: ReactNode;
}>;

function setRole(role: string) {
  act(() => {
    useAuthStore.setState({
      activeCompanyId: companyId,
      user: {
        id: 'user-1',
        email: 'user@example.test',
        firstName: 'Test',
        lastName: 'User',
        companies: [{
          id: companyId,
          name: 'Fixture Company',
          slug: 'fixture',
          role,
          isDefault: true,
        }],
      },
    });
  });
}

beforeEach(() => setRole('viewer'));

describe('protected module role gate', () => {
  it('allows only manager and admin roles for enabled review modules', () => {
    expect(canAccessProtectedModule('customerFactsReview', 'sales_manager')).toBe(true);
    expect(canAccessProtectedModule('salesSequencesManagement', 'company_admin')).toBe(true);
    expect(canAccessProtectedModule('salesSequencesManagement', 'sales_user')).toBe(false);
    expect(canAccessProtectedModule('customerFactsReview', 'viewer')).toBe(false);
  });

  it('denies a disabled feature even to an administrator', () => {
    expect(canAccessProtectedModule('customerFactsReview', 'company_admin', {
      customerFactsReview: false,
      salesSequencesManagement: true,
    })).toBe(false);
    expect(canAccessProtectedModule('salesSequencesManagement', 'company_admin', {
      customerFactsReview: true,
      salesSequencesManagement: false,
    })).toBe(false);
  });

  it.each(['viewer', 'sales_user'])(
    'does not mount direct-URL content or fire its API for %s',
    (role) => {
      setRole(role);
      const apiCall = vi.fn();
      function ProtectedProbe() {
        useEffect(() => { apiCall(); }, []);
        return createElement('div', null, 'protected content');
      }

      render(createElement(
        TestableFeatureRoleGuard,
        { module: 'customerFactsReview' },
        createElement(ProtectedProbe),
      ));

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('protected content')).not.toBeInTheDocument();
      expect(apiCall).not.toHaveBeenCalled();
    },
  );

  it.each(['sales_manager', 'company_admin', 'super_admin'])(
    'mounts enabled direct-URL content for %s',
    (role) => {
      setRole(role);
      const apiCall = vi.fn();
      function ProtectedProbe() {
        useEffect(() => { apiCall(); }, []);
        return createElement('div', null, 'protected content');
      }

      render(createElement(
        TestableFeatureRoleGuard,
        { module: 'salesSequencesManagement' },
        createElement(ProtectedProbe),
      ));

      expect(screen.getByText('protected content')).toBeInTheDocument();
      expect(apiCall).toHaveBeenCalledTimes(1);
    },
  );
});
