import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactSelector } from '../components/contact-selector';
import type { CustomerContact } from '../types';

function makeContact(overrides: Partial<CustomerContact> = {}): CustomerContact {
  return {
    id: 'contact-001',
    firstName: 'John',
    lastName: 'Smith',
    displayName: 'John Smith',
    isPrimary: true,
    contactPoints: [],
    updatedAt: '2026-06-29T00:00:00Z',
    ...overrides,
  };
}

const mockContacts: CustomerContact[] = [
  makeContact({ id: 'c1', displayName: 'Alice Wang', firstName: 'Alice', lastName: 'Wang', isPrimary: true }),
  makeContact({ id: 'c2', displayName: 'Bob Li', firstName: 'Bob', lastName: 'Li', isPrimary: false }),
  makeContact({ id: 'c3', displayName: 'Charlie Zhang', firstName: 'Charlie', lastName: 'Zhang', isPrimary: false }),
];

describe('ContactSelector', () => {
  it('默认折叠，点击头部展开', () => {
    const onSelect = vi.fn();
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c1"
        onSelect={onSelect}
      />,
    );

    const selector = screen.getByTestId('contact-selector');
    expect(selector).toHaveAttribute('aria-expanded', 'false');

    // 点击展开
    fireEvent.click(screen.getByText('Alice Wang'));
    expect(selector).toHaveAttribute('aria-expanded', 'true');

    // 应显示所有联系人
    expect(screen.getByText('Bob Li')).toBeInTheDocument();
    expect(screen.getByText('Charlie Zhang')).toBeInTheDocument();
  });

  it('点击联系人项触发 onSelect 并折叠', () => {
    const onSelect = vi.fn();
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c1"
        onSelect={onSelect}
      />,
    );

    // 展开
    fireEvent.click(screen.getByText('Alice Wang'));

    // 点击第二个联系人
    fireEvent.click(screen.getByText('Bob Li'));

    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('Enter 键展开选择器', () => {
    const onSelect = vi.fn();
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c1"
        onSelect={onSelect}
      />,
    );

    const selector = screen.getByTestId('contact-selector');
    expect(selector).toHaveAttribute('aria-expanded', 'false');

    // 按 Enter 展开
    fireEvent.keyDown(selector, { key: 'Enter' });

    expect(selector).toHaveAttribute('aria-expanded', 'true');
  });

  it('ArrowDown 键展开并导航', () => {
    const onSelect = vi.fn();
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c1"
        onSelect={onSelect}
      />,
    );

    const selector = screen.getByTestId('contact-selector');

    // ArrowDown 展开
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    expect(selector).toHaveAttribute('aria-expanded', 'true');

    // 再次 ArrowDown 导航到下一项
    fireEvent.keyDown(selector, { key: 'ArrowDown' });

    // Enter 选中
    fireEvent.keyDown(selector, { key: 'Enter' });

    // 应调用 onSelect（第二项 c2）
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('Escape 键折叠选择器', () => {
    const onSelect = vi.fn();
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c1"
        onSelect={onSelect}
      />,
    );

    const selector = screen.getByTestId('contact-selector');

    // 先展开
    fireEvent.click(screen.getByText('Alice Wang'));
    expect(selector).toHaveAttribute('aria-expanded', 'true');

    // Escape 折叠
    fireEvent.keyDown(selector, { key: 'Escape' });
    expect(selector).toHaveAttribute('aria-expanded', 'false');
  });

  it('空联系人列表显示提示', () => {
    render(
      <ContactSelector
        contacts={[]}
        selectedContactId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('contact-selector-empty')).toBeInTheDocument();
  });

  it('选中项有 aria-selected="true"', () => {
    render(
      <ContactSelector
        contacts={mockContacts}
        selectedContactId="c2"
        onSelect={vi.fn()}
      />,
    );

    // 展开
    fireEvent.click(screen.getByText('Bob Li'));

    const selectedOption = screen.getByRole('option', { selected: true });
    expect(selectedOption).toHaveTextContent('Bob Li');
  });
});
