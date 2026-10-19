import React, { useState, useEffect } from 'react';
import {
  Users,
  Plus,
  Search,
  Shield,
  Trash2,
  FolderGit2,
  ArrowRight,
  Loader2,
  UserPlus,
  AlertCircle,
  X,
  Pencil,
} from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import {
  apiListTeams,
  apiCreateTeam,
  apiUpdateTeam,
  apiDeleteTeam,
  apiListTeamMembers,
  apiAddTeamMember,
  apiRemoveTeamMember,
  apiSearchUsers,
} from '../lib/api';
import { Team, TeamMember, User } from '../types';
import { ConfirmModal } from '../components/ConfirmModal';

export const TeamsView: React.FC = () => {
  const apiUrl = useHubStore((state) => state.apiUrl);
  const token = useHubStore((state) => state.token);
  const refreshToken = useHubStore((state) => state.refreshToken);
  const user = useHubStore((state) => state.user);
  const selectedTeamId = useHubStore((state) => state.selectedTeamId);
  const setSelectedTeamId = useHubStore((state) => state.setSelectedTeamId);
  const setActiveTab = useHubStore((state) => state.setActiveTab);

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [isLoadingTeams, setIsLoadingTeams] = useState(false);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [searchTeam, setSearchTeam] = useState('');

  // Modals
  const [isCreateTeamOpen, setIsCreateTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [isCreatingTeam, setIsCreatingTeam] = useState(false);

  const [isEditTeamOpen, setIsEditTeamOpen] = useState(false);
  const [editTeamName, setEditTeamName] = useState('');
  const [editTeamDesc, setEditTeamDesc] = useState('');
  const [isUpdatingTeam, setIsUpdatingTeam] = useState(false);

  const [isAddMemberOpen, setIsAddMemberOpen] = useState(false);
  const [userQuery, setUserQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selectedUserToInvite, setSelectedUserToInvite] = useState<User | null>(null);
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'member'>('member');
  const [isAddingMember, setIsAddingMember] = useState(false);

  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'member'>('member');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load teams on mount
  const loadTeams = async () => {
    if (!token) return;
    setIsLoadingTeams(true);
    setErrorMsg(null);
    try {
      const data = await apiListTeams(apiUrl, token, refreshToken || undefined);
      setTeams(data);
      if (data.length > 0 && !selectedTeamId) {
        setSelectedTeamId(data[0].id);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load teams');
    } finally {
      setIsLoadingTeams(false);
    }
  };

  useEffect(() => {
    loadTeams();
  }, [apiUrl, token]);

  // Load members whenever selectedTeamId changes
  useEffect(() => {
    if (!selectedTeamId || !token) return;
    const loadMembers = async () => {
      setIsLoadingMembers(true);
      try {
        const data = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
        setMembers(data);
      } catch (err: any) {
        console.error('Failed to load members:', err);
      } finally {
        setIsLoadingMembers(false);
      }
    };
    loadMembers();
  }, [selectedTeamId, token]);

  const activeTeam = teams.find((t) => t.id === selectedTeamId);

  // Handle Create Team
  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsCreatingTeam(true);
    setErrorMsg(null);
    try {
      const newTeam = await apiCreateTeam(
        apiUrl,
        token,
        newTeamName,
        newTeamDesc,
        refreshToken || undefined
      );
      setTeams([newTeam, ...teams]);
      setSelectedTeamId(newTeam.id);
      setIsCreateTeamOpen(false);
      setNewTeamName('');
      setNewTeamDesc('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to create team');
    } finally {
      setIsCreatingTeam(false);
    }
  };

  // Handle Open Edit Team
  const handleOpenEditTeam = (team: Team) => {
    setEditTeamName(team.name);
    setEditTeamDesc(team.description || '');
    setErrorMsg(null);
    setIsEditTeamOpen(true);
  };

  // Handle Update Team
  const handleUpdateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId) return;
    setIsUpdatingTeam(true);
    setErrorMsg(null);
    try {
      const updated = await apiUpdateTeam(
        apiUrl,
        token,
        selectedTeamId,
        editTeamName.trim(),
        editTeamDesc.trim(),
        refreshToken || undefined
      );
      setTeams(teams.map((t) => (t.id === selectedTeamId ? { ...t, ...updated } : t)));
      setIsEditTeamOpen(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update team');
    } finally {
      setIsUpdatingTeam(false);
    }
  };

  // Search users for invite
  const handleUserSearch = async (query: string) => {
    setUserQuery(query);
    if (!token || query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await apiSearchUsers(apiUrl, token, query.trim(), refreshToken || undefined);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
  };

  // Handle Add Member
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId || !selectedUserToInvite) return;
    setIsAddingMember(true);
    try {
      await apiAddTeamMember(
        apiUrl,
        token,
        selectedTeamId,
        selectedUserToInvite.id,
        newMemberRole,
        refreshToken || undefined
      );
      const updatedMembers = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
      setMembers(updatedMembers);
      setIsAddMemberOpen(false);
      setSelectedUserToInvite(null);
      setUserQuery('');
      setSearchResults([]);
    } catch (err: any) {
      alert(err.message || 'Failed to add team member');
    } finally {
      setIsAddingMember(false);
    }
  };

  // State for Confirmations
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);
  const [isRemovingMember, setIsRemovingMember] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);
  const [isDeletingTeam, setIsDeletingTeam] = useState(false);

  // Handle Remove Member Confirmation
  const confirmRemoveMember = async () => {
    if (!token || !selectedTeamId || !memberToRemove) return;
    setIsRemovingMember(true);
    try {
      await apiRemoveTeamMember(apiUrl, token, selectedTeamId, memberToRemove.user_id, refreshToken || undefined);
      setMembers(members.filter((m) => m.user_id !== memberToRemove.user_id));
      setMemberToRemove(null);
    } catch (err: any) {
      alert(err.message || 'Failed to remove member');
    } finally {
      setIsRemovingMember(false);
    }
  };

  // Handle Delete Team Confirmation
  const confirmDeleteTeam = async () => {
    if (!token || !teamToDelete) return;
    setIsDeletingTeam(true);
    try {
      await apiDeleteTeam(apiUrl, token, teamToDelete.id, refreshToken || undefined);
      const updatedTeams = teams.filter((t) => t.id !== teamToDelete.id);
      setTeams(updatedTeams);
      if (selectedTeamId === teamToDelete.id) {
        setSelectedTeamId(updatedTeams[0]?.id || null);
      }
      setTeamToDelete(null);
    } catch (err: any) {
      alert(err.message || 'Failed to delete team');
    } finally {
      setIsDeletingTeam(false);
    }
  };

  // Handle Update Member Role
  const handleUpdateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId || !editingMember) return;
    setIsUpdatingRole(true);
    setErrorMsg(null);
    try {
      await apiAddTeamMember(apiUrl, token, selectedTeamId, editingMember.user_id, editRole, refreshToken || undefined);
      const updatedMembers = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
      setMembers(updatedMembers);
      setEditingMember(null);
    } catch (err: any) {
      alert(err.message || 'Failed to update member role');
    } finally {
      setIsUpdatingRole(false);
    }
  };

  const filteredTeams = teams.filter((t) =>
    t.name.toLowerCase().includes(searchTeam.toLowerCase())
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left Column: Teams List */}
      <div className="w-80 shrink-0 border-r border-zinc-800 bg-zinc-950/50 flex flex-col justify-between">
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-400" />
              <span>Teams ({teams.length})</span>
            </h2>
            {user?.role === 'superadmin' && (
              <button
                onClick={() => setIsCreateTeamOpen(true)}
                className="flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-sm"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Team</span>
              </button>
            )}
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search teams..."
              value={searchTeam}
              onChange={(e) => setSearchTeam(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Teams Scrollable List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoadingTeams ? (
            <div className="flex items-center justify-center py-10 text-xs text-zinc-500 gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              <span>Loading teams...</span>
            </div>
          ) : filteredTeams.length === 0 ? (
            <div className="py-10 text-center text-xs text-zinc-500">
              No teams found. {user?.role === 'superadmin' && 'Create one to get started.'}
            </div>
          ) : (
            filteredTeams.map((team) => {
              const isSelected = team.id === selectedTeamId;
              return (
                <button
                  key={team.id}
                  onClick={() => setSelectedTeamId(team.id)}
                  className={`w-full text-left rounded-xl p-3 transition border ${
                    isSelected
                      ? 'border-indigo-500/50 bg-indigo-950/20 text-white shadow-sm'
                      : 'border-zinc-800/40 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-xs truncate">{team.name}</span>
                    {team.user_role && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.2 text-[9px] font-bold text-zinc-400 uppercase">
                        {team.user_role}
                      </span>
                    )}
                  </div>
                  {team.description && (
                    <p className="text-[11px] text-zinc-400 line-clamp-1">{team.description}</p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right Column: Selected Team Management */}
      <div className="flex-1 overflow-y-auto p-8 bg-zinc-950">
        {activeTeam ? (
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-150">
            {/* Team Banner */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-xl font-bold text-zinc-100">{activeTeam.name}</h1>
                  <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-semibold text-indigo-400">
                    Team Organization
                  </span>
                  {user?.role === 'superadmin' && (
                    <button
                      onClick={() => handleOpenEditTeam(activeTeam)}
                      className="rounded-lg p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
                      title="Edit Team"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-zinc-400 max-w-xl">
                  {activeTeam.description || 'No description provided for this team.'}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {user?.role === 'superadmin' && (
                  <>
                    <button
                      onClick={() => handleOpenEditTeam(activeTeam)}
                      className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition shadow-sm"
                    >
                      <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                      <span>Edit Team</span>
                    </button>
                    <button
                      onClick={() => setTeamToDelete(activeTeam)}
                      className="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 transition shadow-sm"
                      title="Delete Team"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete Team</span>
                    </button>
                  </>
                )}
                {/* View Projects Link */}
                <button
                  onClick={() => {
                    setSelectedTeamId(activeTeam.id);
                    setActiveTab('projects');
                  }}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-sky-500/20 hover:from-sky-500 hover:to-indigo-500 transition"
                >
                  <FolderGit2 className="h-4 w-4" />
                  <span>Manage Team Projects</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Team Members Section */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-zinc-100">Team Members</h3>
                  <p className="text-xs text-zinc-400">
                    Members can see projects they are assigned to within this team
                  </p>
                </div>

                <button
                  onClick={() => setIsAddMemberOpen(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-400 hover:bg-sky-500/20 transition shadow-sm"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  <span>Add Member</span>
                </button>
              </div>

              {/* Members Table */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase text-[10px] font-semibold">
                    <tr>
                      <th className="px-4 py-3">Member</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Team Role</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-200">
                    {isLoadingMembers ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-zinc-500">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2 text-sky-400" />
                          Loading members...
                        </td>
                      </tr>
                    ) : members.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-zinc-500">
                          No members in this team yet.
                        </td>
                      </tr>
                    ) : (
                      members.map((member) => {
                        const mName = member.user?.name || member.name || 'Member';
                        const mEmail = member.user?.email || member.email || '';
                        return (
                          <tr key={member.user_id} className="hover:bg-zinc-800/30 transition">
                            <td className="px-4 py-3 font-medium flex items-center gap-2">
                              <div className="h-7 w-7 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-[11px] text-zinc-300 border border-zinc-700/50">
                                {mName[0].toUpperCase()}
                              </div>
                              <span>{mName}</span>
                            </td>
                            <td className="px-4 py-3 text-zinc-400">{mEmail}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                member.role === 'admin'
                                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  : 'bg-zinc-800 text-zinc-300'
                              }`}
                            >
                              {member.role}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => {
                                  setEditingMember(member);
                                  setEditRole(member.role);
                                }}
                                className="rounded p-1 text-zinc-500 hover:bg-sky-500/10 hover:text-sky-400 transition"
                                title="Edit Role"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              {member.user_id !== user?.id && (
                                <button
                                  onClick={() => setMemberToRemove(member)}
                                  className="rounded p-1 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400 transition"
                                  title="Remove Member"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">
            Select a team from the list to view members and settings.
          </div>
        )}
      </div>

      {/* Modal: Create Team */}
      {isCreateTeamOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Users className="h-5 w-5 text-indigo-400" />
                <span>Create New Team</span>
              </h3>
              <button
                onClick={() => setIsCreateTeamOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {errorMsg && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleCreateTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Team Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Core Engineering"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Description (Optional)</label>
                <textarea
                  placeholder="Team description or purpose"
                  rows={3}
                  value={newTeamDesc}
                  onChange={(e) => setNewTeamDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateTeamOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingTeam}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isCreatingTeam ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create Team'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Add Member */}
      {isAddMemberOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-sky-400" />
                <span>Add Team Member</span>
              </h3>
              <button
                onClick={() => setIsAddMemberOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAddMember} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Search Registered User
                </label>
                <input
                  type="text"
                  placeholder="Search user by email or name..."
                  value={userQuery}
                  onChange={(e) => handleUserSearch(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />

                {/* Search Results Dropdown */}
                {searchResults.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/90 divide-y divide-zinc-800">
                    {searchResults.map((u) => (
                      <button
                        type="button"
                        key={u.id}
                        onClick={() => {
                          setSelectedUserToInvite(u);
                          setUserQuery(u.email);
                          setSearchResults([]);
                        }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-zinc-800 flex items-center justify-between transition"
                      >
                        <div>
                          <div className="font-semibold text-zinc-200">{u.name}</div>
                          <div className="text-[11px] text-zinc-400">{u.email}</div>
                        </div>
                        <span className="text-[10px] text-sky-400 font-medium">Select</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {selectedUserToInvite && (
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2.5 text-xs text-sky-300">
                  Selected User: <strong>{selectedUserToInvite.name}</strong> ({selectedUserToInvite.email})
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Team Role</label>
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as any)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                >
                  <option value="member">Member (Can access assigned projects)</option>
                  <option value="admin">Admin (Can manage team projects &amp; members)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddMemberOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedUserToInvite || isAddingMember}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isAddingMember ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm Add Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal: Edit Team Member Role */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Shield className="h-4 w-4 text-sky-400" />
                <span>Edit Member Role</span>
              </h3>
              <button
                onClick={() => setEditingMember(null)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 rounded-lg bg-zinc-900/60 border border-zinc-800/80 p-3 text-xs">
              <div className="font-semibold text-zinc-200">
                {editingMember.user?.name || editingMember.name || 'Member'}
              </div>
              <div className="text-zinc-400 text-[11px] truncate">
                {editingMember.user?.email || editingMember.email}
              </div>
            </div>

            <form onSubmit={handleUpdateRole} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Team Role
                </label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as 'admin' | 'member')}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                >
                  <option value="member">Member (Can access assigned projects)</option>
                  <option value="admin">Admin (Can manage team projects &amp; members)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingMember(null)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingRole}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isUpdatingRole ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal: Edit Team */}
      {isEditTeamOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Pencil className="h-5 w-5 text-indigo-400" />
                <span>Edit Team</span>
              </h3>
              <button
                onClick={() => setIsEditTeamOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {errorMsg && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleUpdateTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Team Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Core Engineering"
                  value={editTeamName}
                  onChange={(e) => setEditTeamName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Description (Optional)</label>
                <textarea
                  placeholder="Team description or purpose"
                  rows={3}
                  value={editTeamDesc}
                  onChange={(e) => setEditTeamDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsEditTeamOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingTeam || !editTeamName.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isUpdatingTeam ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Removing Member */}
      <ConfirmModal
        isOpen={!!memberToRemove}
        onClose={() => setMemberToRemove(null)}
        onConfirm={confirmRemoveMember}
        isLoading={isRemovingMember}
        title="Remove Team Member"
        message={
          <span>
            Are you sure you want to remove{' '}
            <strong className="text-zinc-200">
              {memberToRemove?.name || memberToRemove?.email || 'this member'}
            </strong>{' '}
            from the team? They will lose access to all projects and synchronized data in this team.
          </span>
        }
        confirmText="Remove Member"
        variant="danger"
      />

      {/* Confirmation Modal for Deleting Team */}
      <ConfirmModal
        isOpen={!!teamToDelete}
        onClose={() => setTeamToDelete(null)}
        onConfirm={confirmDeleteTeam}
        isLoading={isDeletingTeam}
        title="Delete Team"
        message={
          <span>
            Are you sure you want to delete team{' '}
            <strong className="text-zinc-200">"{teamToDelete?.name}"</strong>? This action cannot be undone and will permanently delete all associated projects, collections, and team memberships.
          </span>
        }
        confirmText="Delete Team"
        variant="danger"
      />
    </div>
  );
};
