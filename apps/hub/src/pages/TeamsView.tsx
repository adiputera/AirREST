import React, { useState, useEffect, useRef } from 'react';
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
  ArrowLeft,
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
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

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
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selectedUsersToInvite, setSelectedUsersToInvite] = useState<User[]>([]);
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'member'>('member');
  const [isAddingMember, setIsAddingMember] = useState(false);

  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'member'>('member');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Ignore responses after navigation, session changes, or unmount.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadTeams = async () => {
      setIsLoadingTeams(true);
      setErrorMsg(null);
      try {
        const data = await apiListTeams(apiUrl, token, refreshToken || undefined);
        if (cancelled) return;
        setTeams(data);
        if (!data.some((team) => team.id === useHubStore.getState().selectedTeamId)) {
          setSelectedTeamId(data[0]?.id || null);
        }
      } catch (err) {
        if (!cancelled) setErrorMsg(err instanceof Error ? err.message : 'Failed to load teams');
      } finally {
        if (!cancelled) setIsLoadingTeams(false);
      }
    };
    loadTeams();
    return () => { cancelled = true; };
  }, [apiUrl, token]);

  useEffect(() => {
    setMembers([]);
    setIsLoadingMembers(false);
    if (!selectedTeamId || !token) return;
    let cancelled = false;
    const loadMembers = async () => {
      setIsLoadingMembers(true);
      try {
        const data = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
        if (cancelled || useHubStore.getState().selectedTeamId !== selectedTeamId) return;
        setMembers(data);
      } catch (err) {
        if (!cancelled) setErrorMsg(err instanceof Error ? err.message : 'Failed to load members');
      } finally {
        if (!cancelled) setIsLoadingMembers(false);
      }
    };
    loadMembers();
    return () => { cancelled = true; };
  }, [selectedTeamId, apiUrl, token]);

  const activeTeam = teams.find((t) => t.id === selectedTeamId);
  const isTeamAdmin = user?.role === 'superadmin' || activeTeam?.user_role === 'admin';

  // Handle Create Team
  const resetCreateTeamForm = () => {
    setNewTeamName('');
    setNewTeamDesc('');
    setErrorMsg(null);
  };

  const handleOpenCreateTeam = () => {
    resetCreateTeamForm();
    setIsCreateTeamOpen(true);
  };

  const handleCloseCreateTeam = () => {
    setIsCreateTeamOpen(false);
    resetCreateTeamForm();
  };

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
      setTeams((previous) => [newTeam, ...previous]);
      setSelectedTeamId(newTeam.id);
      setMobileView('detail');
      handleCloseCreateTeam();
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

  const handleCloseEditTeam = () => {
    setIsEditTeamOpen(false);
    setEditTeamName('');
    setEditTeamDesc('');
    setErrorMsg(null);
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
      setTeams((previous) => previous.map((t) => (t.id === selectedTeamId ? { ...t, ...updated } : t)));
      handleCloseEditTeam();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update team');
    } finally {
      setIsUpdatingTeam(false);
    }
  };

  // Search users for invite with sequence tracking to prevent out-of-order race conditions
  const searchSeqRef = useRef(0);
  const handleUserSearch = async (query: string) => {
    setUserQuery(query);
    if (!token || query.trim().length < 2) {
      setSearchResults([]);
      setIsSearchingUsers(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setIsSearchingUsers(true);
    try {
      const results = await apiSearchUsers(apiUrl, token, query.trim(), refreshToken || undefined);
      if (seq === searchSeqRef.current) {
        setSearchResults(results);
      }
    } catch {
      if (seq === searchSeqRef.current) {
        setSearchResults([]);
      }
    } finally {
      if (seq === searchSeqRef.current) {
        setIsSearchingUsers(false);
      }
    }
  };

  // Toggle user in multi-selection
  const toggleSelectUser = (targetUser: User) => {
    setSelectedUsersToInvite((prev) => {
      const exists = prev.some((u) => u.id === targetUser.id);
      if (exists) {
        return prev.filter((u) => u.id !== targetUser.id);
      } else {
        return [...prev, targetUser];
      }
    });
  };

  // Remove selected user from chips
  const removeSelectedUser = (userId: string) => {
    setSelectedUsersToInvite((prev) => prev.filter((u) => u.id !== userId));
  };

  // Select / Deselect all eligible search results
  const handleSelectAllResults = (selectableList: User[]) => {
    setSelectedUsersToInvite((prev) => {
      const allSelected = selectableList.every((su) => prev.some((u) => u.id === su.id));
      if (allSelected) {
        const resultIds = new Set(selectableList.map((su) => su.id));
        return prev.filter((u) => !resultIds.has(u.id));
      } else {
        const prevMap = new Map(prev.map((u) => [u.id, u]));
        selectableList.forEach((su) => prevMap.set(su.id, su));
        return Array.from(prevMap.values());
      }
    });
  };

  // Handle Add Member(s)
  const resetAddMemberForm = () => {
    setUserQuery('');
    setSearchResults([]);
    setSelectedUsersToInvite([]);
    setNewMemberRole('member');
    setErrorMsg(null);
  };

  const handleOpenAddMember = () => {
    resetAddMemberForm();
    setIsAddMemberOpen(true);
  };

  const handleCloseAddMember = () => {
    setIsAddMemberOpen(false);
    resetAddMemberForm();
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId || selectedUsersToInvite.length === 0) return;
    setIsAddingMember(true);
    try {
      const results = await Promise.allSettled(
        selectedUsersToInvite.map((u) =>
          apiAddTeamMember(
            apiUrl,
            token,
            selectedTeamId,
            u.id,
            newMemberRole,
            refreshToken || undefined
          )
        )
      );

      const successfulIds = new Set<string>();
      const failedUsers: { user: User; error: string }[] = [];

      results.forEach((res, index) => {
        const u = selectedUsersToInvite[index];
        if (res.status === 'fulfilled') {
          successfulIds.add(u.id);
        } else {
          failedUsers.push({
            user: u,
            error: res.reason?.message || 'Failed to add member',
          });
        }
      });

      if (useHubStore.getState().selectedTeamId === selectedTeamId) {
        const updatedMembers = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
        if (useHubStore.getState().selectedTeamId === selectedTeamId) {
          setMembers(updatedMembers);
        }
      }

      if (failedUsers.length === 0) {
        handleCloseAddMember();
      } else {
        // Keep failed users in selected state for retry
        setSelectedUsersToInvite((prev) => prev.filter((u) => !successfulIds.has(u.id)));
        const errorList = failedUsers.map((f) => `${f.user.name || f.user.email}: ${f.error}`).join('\n');
        alert(`Added ${successfulIds.size} member(s).\nFailed to add ${failedUsers.length} member(s):\n${errorList}`);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to add team members');
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
      if (useHubStore.getState().selectedTeamId !== selectedTeamId) return;
      setMembers((previous) => previous.filter((m) => m.user_id !== memberToRemove.user_id));
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
      if (useHubStore.getState().selectedTeamId === teamToDelete.id) {
        const nextId = updatedTeams[0]?.id || null;
        setSelectedTeamId(nextId);
        if (!nextId) {
          setMobileView('list');
        }
      }
      setTeamToDelete(null);
    } catch (err: any) {
      alert(err.message || 'Failed to delete team');
    } finally {
      setIsDeletingTeam(false);
    }
  };

  // Handle Update Member Role
  const handleOpenEditMember = (member: TeamMember) => {
    setEditingMember(member);
    setEditRole(member.role);
    setErrorMsg(null);
  };

  const handleCloseEditMember = () => {
    setEditingMember(null);
    setEditRole('member');
    setErrorMsg(null);
  };

  const handleUpdateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId || !editingMember) return;
    setIsUpdatingRole(true);
    setErrorMsg(null);
    try {
      await apiAddTeamMember(apiUrl, token, selectedTeamId, editingMember.user_id, editRole, refreshToken || undefined);
      if (useHubStore.getState().selectedTeamId !== selectedTeamId) return;
      const updatedMembers = await apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined);
      if (useHubStore.getState().selectedTeamId !== selectedTeamId) return;
      setMembers(updatedMembers);
      handleCloseEditMember();
    } catch (err: any) {
      alert(err.message || 'Failed to update member role');
    } finally {
      setIsUpdatingRole(false);
    }
  };

  const filteredTeams = teams.filter((t) =>
    t.name.toLowerCase().includes(searchTeam.toLowerCase())
  );

  const showListOnMobile = mobileView === 'list' || !activeTeam;
  const showDetailOnMobile = mobileView === 'detail' && !!activeTeam;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left Column: Teams List */}
      <div
        className={`w-full md:w-72 lg:w-80 shrink-0 border-r border-zinc-800 bg-zinc-950/50 flex flex-col justify-between ${
          showListOnMobile ? 'flex' : 'hidden md:flex'
        }`}
      >
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-400" />
              <span>Teams ({teams.length})</span>
            </h2>
            {user?.role === 'superadmin' && (
              <button
                onClick={handleOpenCreateTeam}
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
                  onClick={() => {
                    setSelectedTeamId(team.id);
                    setMobileView('detail');
                  }}
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
      <div
        className={`flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 bg-zinc-950 ${
          showDetailOnMobile ? 'block' : 'hidden md:block'
        }`}
      >
        {activeTeam ? (
          <div className="max-w-5xl mx-auto space-y-6 sm:space-y-8 animate-in fade-in duration-150">
            {/* Mobile Back Button */}
            <div className="md:hidden">
              <button
                type="button"
                onClick={() => setMobileView('list')}
                className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white transition shadow-sm"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to Teams</span>
              </button>
            </div>

            {/* Team Banner */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-6 flex flex-col xl:flex-row xl:items-center justify-between gap-4 sm:gap-6">
              <div className="min-w-0 flex-1 space-y-2">
                <h1 className="text-xl md:text-2xl font-bold text-zinc-100 tracking-tight">
                  {activeTeam.name}
                </h1>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-semibold text-indigo-400 shrink-0">
                    <Users className="h-3 w-3" />
                    Team Organization
                  </span>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed max-w-2xl">
                  {activeTeam.description || 'No description provided for this team.'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0 self-start xl:self-auto">
                {user?.role === 'superadmin' && (
                  <>
                    <button
                      onClick={() => handleOpenEditTeam(activeTeam)}
                      className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800/80 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition shadow-sm whitespace-nowrap"
                    >
                      <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                      <span>Edit Team</span>
                    </button>
                    <button
                      onClick={() => setTeamToDelete(activeTeam)}
                      className="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 transition shadow-sm whitespace-nowrap"
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
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-sky-500/20 hover:from-sky-500 hover:to-indigo-500 transition whitespace-nowrap"
                >
                  <FolderGit2 className="h-4 w-4" />
                  <span>Manage Team Projects</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Team Members Section */}
            <div>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4 mb-4">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-zinc-100">Team Members</h3>
                    <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 border border-zinc-700/50">
                      {members.length} {members.length === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Members can see projects they are assigned to within this team
                  </p>
                </div>

                {isTeamAdmin && (
                  <button
                    onClick={handleOpenAddMember}
                    className="flex items-center gap-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-400 hover:bg-sky-500/20 transition shadow-sm shrink-0 whitespace-nowrap self-start sm:self-auto"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    <span>Add Members</span>
                  </button>
                )}
              </div>

              {/* Members Table */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[500px] sm:min-w-full text-left text-xs">
                    <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase text-[10px] font-semibold">
                      <tr>
                        <th className="px-4 py-3">Member</th>
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">Team Role</th>
                        {isTeamAdmin && <th className="px-4 py-3 text-right">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60 text-zinc-200">
                      {isLoadingMembers ? (
                        <tr>
                          <td colSpan={isTeamAdmin ? 4 : 3} className="py-8 text-center text-zinc-500">
                            <Loader2 className="h-4 w-4 animate-spin inline mr-2 text-sky-400" />
                            Loading members...
                          </td>
                        </tr>
                      ) : members.length === 0 ? (
                        <tr>
                          <td colSpan={isTeamAdmin ? 4 : 3} className="py-8 text-center text-zinc-500">
                            No members in this team yet.
                          </td>
                        </tr>
                      ) : (
                        members.map((member) => {
                          const mName = member.user?.name || member.name || 'Member';
                          const mEmail = member.user?.email || member.email || '';
                          const isSuper = member.user?.role === 'superadmin';
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
                                {isSuper ? (
                                  <span className="rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider inline-flex items-center gap-1">
                                    <Shield className="h-3 w-3" />
                                    Superadmin
                                  </span>
                                ) : (
                                  <span
                                    className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                      member.role === 'admin'
                                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                        : 'bg-zinc-800 text-zinc-300'
                                    }`}
                                  >
                                    {member.role}
                                  </span>
                                )}
                              </td>
                              {isTeamAdmin && (
                                <td className="px-4 py-3 text-right">
                                  {isSuper ? (
                                    <span className="text-[10px] text-zinc-500 italic pr-1" title="Superadmin permissions are system-wide and cannot be modified">
                                      Permanent
                                    </span>
                                  ) : (
                                    <div className="flex items-center justify-end gap-1">
                                      <button
                                        onClick={() => handleOpenEditMember(member)}
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
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })
                    )}
                    </tbody>
                  </table>
                </div>
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
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !isCreatingTeam) {
              handleCloseCreateTeam();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Users className="h-5 w-5 text-indigo-400" />
                <span>Create New Team</span>
              </h3>
              <button
                onClick={handleCloseCreateTeam}
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
                  onClick={handleCloseCreateTeam}
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
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !isAddingMember) {
              handleCloseAddMember();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-4 sm:p-6 shadow-2xl flex flex-col max-h-[90dvh]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-sky-400" />
                <span>Add Team Members</span>
              </h3>
              <button
                onClick={handleCloseAddMember}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAddMember} className="space-y-4 flex flex-col flex-1 overflow-hidden">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Search Registered Users
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                  <input
                    type="text"
                    placeholder="Search user by email or name..."
                    value={userQuery}
                    onChange={(e) => handleUserSearch(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-9 pr-8 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                  />
                  {isSearchingUsers ? (
                    <Loader2 className="absolute right-3 top-2.5 h-3.5 w-3.5 animate-spin text-zinc-400" />
                  ) : userQuery ? (
                    <button
                      type="button"
                      onClick={() => handleUserSearch('')}
                      className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 p-0.5"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Search Results Area */}
              {userQuery.trim().length >= 2 && (
                <div className="flex flex-col flex-1 min-h-[140px] max-h-52 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
                  {searchResults.length === 0 && !isSearchingUsers ? (
                    <div className="p-4 text-center text-xs text-zinc-500">
                      No users found matching "{userQuery}"
                    </div>
                  ) : (
                    <>
                      {/* Select all header */}
                      {(() => {
                        const eligibleUsers = searchResults.filter((u) => u.role !== 'superadmin' && !members.some((m) => m.user_id === u.id));
                        const allEligibleSelected =
                          eligibleUsers.length > 0 &&
                          eligibleUsers.every((eu) => selectedUsersToInvite.some((u) => u.id === eu.id));

                        return (
                          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/90 text-[11px] text-zinc-400">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                disabled={eligibleUsers.length === 0}
                                checked={allEligibleSelected}
                                onChange={() => handleSelectAllResults(eligibleUsers)}
                                className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-zinc-950 cursor-pointer disabled:cursor-not-allowed"
                              />
                              <span className="font-medium text-zinc-300">
                                {allEligibleSelected ? 'Deselect All Results' : 'Select All Results'}
                              </span>
                            </label>
                            <span>
                              {eligibleUsers.length} available · {searchResults.length - eligibleUsers.length} in team / superadmin
                            </span>
                          </div>
                        );
                      })()}

                      {/* User Items List */}
                      <div className="overflow-y-auto divide-y divide-zinc-800/60 p-1">
                        {searchResults.map((u) => {
                          const isSuperadmin = u.role === 'superadmin';
                          const isAlreadyMember = isSuperadmin || members.some((m) => m.user_id === u.id);
                          const isChecked = selectedUsersToInvite.some((su) => su.id === u.id);

                          return (
                            <label
                              key={u.id}
                              className={`flex items-center justify-between px-3 py-2 rounded-md transition select-none ${
                                isAlreadyMember
                                  ? 'opacity-40 cursor-not-allowed bg-zinc-900/30'
                                  : isChecked
                                  ? 'bg-sky-500/10 cursor-pointer hover:bg-sky-500/15'
                                  : 'hover:bg-zinc-800/60 cursor-pointer'
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <input
                                  type="checkbox"
                                  disabled={isAlreadyMember}
                                  checked={isChecked}
                                  onChange={() => !isAlreadyMember && toggleSelectUser(u)}
                                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-800 text-sky-500 focus:ring-sky-500 focus:ring-offset-zinc-950 cursor-pointer disabled:cursor-not-allowed"
                                />
                                <div className="truncate">
                                  <div className="text-xs font-semibold text-zinc-200 truncate">{u.name}</div>
                                  <div className="text-[11px] text-zinc-400 truncate">{u.email}</div>
                                </div>
                              </div>
                              {isSuperadmin ? (
                                <span className="text-[10px] uppercase font-bold tracking-wider text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20 inline-flex items-center gap-1" title="Superadmin has system-wide administrative access">
                                  <Shield className="h-2.5 w-2.5" />
                                  Superadmin
                                </span>
                              ) : isAlreadyMember ? (
                                <span className="text-[10px] uppercase font-semibold tracking-wider text-amber-400/80 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20 shrink-0">
                                  In Team
                                </span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Selected Users Chips */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-zinc-300">
                    Selected Members ({selectedUsersToInvite.length})
                  </label>
                  {selectedUsersToInvite.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedUsersToInvite([])}
                      className="text-[11px] text-zinc-400 hover:text-red-400 transition"
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {selectedUsersToInvite.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
                    No users selected yet. Search above and check users to add.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-2 rounded-lg border border-zinc-800 bg-zinc-900/50">
                    {selectedUsersToInvite.map((u) => (
                      <span
                        key={u.id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 border border-sky-500/30 px-2.5 py-0.5 text-[11px] text-sky-200"
                      >
                        <span className="font-medium truncate max-w-[120px]">{u.name}</span>
                        <button
                          type="button"
                          onClick={() => removeSelectedUser(u.id)}
                          className="text-sky-400 hover:text-white transition"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

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

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={handleCloseAddMember}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={selectedUsersToInvite.length === 0 || isAddingMember}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isAddingMember ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    `Confirm Add ${selectedUsersToInvite.length > 0 ? `${selectedUsersToInvite.length} ` : ''}Member${
                      selectedUsersToInvite.length > 1 ? 's' : ''
                    }`
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal: Edit Team Member Role */}
      {editingMember && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !isUpdatingRole) {
              handleCloseEditMember();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-sm max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Shield className="h-4 w-4 text-sky-400" />
                <span>Edit Member Role</span>
              </h3>
              <button
                onClick={handleCloseEditMember}
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
                  onClick={handleCloseEditMember}
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
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget && !isUpdatingTeam) {
              handleCloseEditTeam();
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Pencil className="h-5 w-5 text-indigo-400" />
                <span>Edit Team</span>
              </h3>
              <button
                onClick={handleCloseEditTeam}
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
                  onClick={handleCloseEditTeam}
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
