import React, { useState, useEffect } from 'react';
import {
  FolderGit2,
  Users,
  Plus,
  Shield,
  Trash2,
  Search,
  Loader2,
  UserCheck,
  AlertCircle,
  X,
  Info,
  Pencil,
} from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import {
  apiListTeams,
  apiListTeamProjects,
  apiCreateProject,
  apiListProjectMembers,
  apiAddProjectMember,
  apiRemoveProjectMember,
  apiListTeamMembers,
} from '../lib/api';
import { Team, Project, ProjectMember, TeamMember } from '../types';

export const ProjectsView: React.FC = () => {
  const apiUrl = useHubStore((state) => state.apiUrl);
  const token = useHubStore((state) => state.token);
  const refreshToken = useHubStore((state) => state.refreshToken);
  const user = useHubStore((state) => state.user);
  const selectedTeamId = useHubStore((state) => state.selectedTeamId);
  const setSelectedTeamId = useHubStore((state) => state.setSelectedTeamId);
  const selectedProjectId = useHubStore((state) => state.selectedProjectId);
  const setSelectedProjectId = useHubStore((state) => state.setSelectedProjectId);

  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);

  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [searchProject, setSearchProject] = useState('');

  // Modals
  const [isCreateProjOpen, setIsCreateProjOpen] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [isCreatingProj, setIsCreatingProj] = useState(false);

  const [isAssignMemberOpen, setIsAssignMemberOpen] = useState(false);
  const [selectedUserIdToAssign, setSelectedUserIdToAssign] = useState<string>('');
  const [assignedRole, setAssignedRole] = useState<'admin' | 'maintainer' | 'contributor' | 'reader'>('contributor');
  const [isAssigningMember, setIsAssigningMember] = useState(false);

  const [editingMember, setEditingMember] = useState<ProjectMember | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'maintainer' | 'contributor' | 'reader'>('contributor');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. Load teams list
  useEffect(() => {
    if (!token) return;
    const loadTeams = async () => {
      try {
        const data = await apiListTeams(apiUrl, token, refreshToken || undefined);
        setTeams(data);
        if (data.length > 0 && !selectedTeamId) {
          setSelectedTeamId(data[0].id);
        }
      } catch (err) {
        console.error('Failed to load teams:', err);
      }
    };
    loadTeams();
  }, [apiUrl, token]);

  // 2. Load projects for selected team
  useEffect(() => {
    if (!selectedTeamId || !token) return;
    const loadProjects = async () => {
      setIsLoadingProjects(true);
      setErrorMsg(null);
      try {
        const [projData, tmData] = await Promise.all([
          apiListTeamProjects(apiUrl, token, selectedTeamId, refreshToken || undefined),
          apiListTeamMembers(apiUrl, token, selectedTeamId, refreshToken || undefined),
        ]);
        setProjects(projData);
        setTeamMembers(tmData);

        if (projData.length > 0) {
          if (!selectedProjectId || !projData.some((p) => p.id === selectedProjectId)) {
            setSelectedProjectId(projData[0].id);
          }
        } else {
          setSelectedProjectId(null);
        }
      } catch (err: any) {
        setErrorMsg(err.message || 'Failed to load projects');
      } finally {
        setIsLoadingProjects(false);
      }
    };
    loadProjects();
  }, [selectedTeamId, token]);

  // 3. Load project members for selected project
  useEffect(() => {
    if (!selectedProjectId || !token) {
      setProjectMembers([]);
      return;
    }
    const loadMembers = async () => {
      setIsLoadingMembers(true);
      try {
        const data = await apiListProjectMembers(apiUrl, token, selectedProjectId, refreshToken || undefined);
        setProjectMembers(data);
      } catch (err) {
        console.error('Failed to load project members:', err);
      } finally {
        setIsLoadingMembers(false);
      }
    };
    loadMembers();
  }, [selectedProjectId, token]);

  const activeProject = projects.find((p) => p.id === selectedProjectId);
  const activeTeam = teams.find((t) => t.id === selectedTeamId);

  // Handle Create Project
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedTeamId) return;
    setIsCreatingProj(true);
    setErrorMsg(null);
    try {
      const newProj = await apiCreateProject(
        apiUrl,
        token,
        selectedTeamId,
        newProjName,
        newProjDesc,
        refreshToken || undefined
      );
      setProjects([newProj, ...projects]);
      setSelectedProjectId(newProj.id);
      setIsCreateProjOpen(false);
      setNewProjName('');
      setNewProjDesc('');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to create project');
    } finally {
      setIsCreatingProj(false);
    }
  };

  // Handle Assign Member
  const handleAssignMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedProjectId || !selectedUserIdToAssign) return;
    setIsAssigningMember(true);
    try {
      await apiAddProjectMember(
        apiUrl,
        token,
        selectedProjectId,
        selectedUserIdToAssign,
        assignedRole,
        refreshToken || undefined
      );
      const updated = await apiListProjectMembers(apiUrl, token, selectedProjectId, refreshToken || undefined);
      setProjectMembers(updated);
      setIsAssignMemberOpen(false);
      setSelectedUserIdToAssign('');
    } catch (err: any) {
      alert(err.message || 'Failed to assign project member');
    } finally {
      setIsAssigningMember(false);
    }
  };

  // Handle Remove Member
  const handleRemoveMember = async (memberUserId: string) => {
    if (!token || !selectedProjectId) return;
    if (!confirm('Are you sure you want to unassign this member from the project?')) return;
    try {
      await apiRemoveProjectMember(apiUrl, token, selectedProjectId, memberUserId, refreshToken || undefined);
      setProjectMembers(projectMembers.filter((m) => m.user_id !== memberUserId));
    } catch (err: any) {
      alert(err.message || 'Failed to unassign member');
    }
  };

  // Handle Update Member Role
  const handleUpdateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedProjectId || !editingMember) return;
    setIsUpdatingRole(true);
    setErrorMsg(null);
    try {
      await apiAddProjectMember(
        apiUrl,
        token,
        selectedProjectId,
        editingMember.user_id,
        editRole,
        refreshToken || undefined
      );
      const updated = await apiListProjectMembers(apiUrl, token, selectedProjectId, refreshToken || undefined);
      setProjectMembers(updated);
      setEditingMember(null);
    } catch (err: any) {
      alert(err.message || 'Failed to update project member role');
    } finally {
      setIsUpdatingRole(false);
    }
  };

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(searchProject.toLowerCase())
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left Column: Team Switcher & Projects List */}
      <div className="w-80 shrink-0 border-r border-zinc-800 bg-zinc-950/50 flex flex-col justify-between">
        <div className="p-4 border-b border-zinc-800 space-y-3">
          {/* Team Switcher */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">
              Active Team
            </label>
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5">
              <Users className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
              <select
                value={selectedTeamId || ''}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="w-full bg-transparent text-xs font-semibold text-zinc-200 focus:outline-none cursor-pointer truncate"
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id} className="bg-zinc-900 text-zinc-200">
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <h2 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5">
              <FolderGit2 className="h-3.5 w-3.5 text-sky-400" />
              <span>Projects ({projects.length})</span>
            </h2>
            <button
              onClick={() => setIsCreateProjOpen(true)}
              className="flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Project</span>
            </button>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search projects..."
              value={searchProject}
              onChange={(e) => setSearchProject(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Projects Scrollable List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoadingProjects ? (
            <div className="flex items-center justify-center py-10 text-xs text-zinc-500 gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              <span>Loading projects...</span>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="py-10 text-center text-xs text-zinc-500">
              No projects in this team yet.
            </div>
          ) : (
            filteredProjects.map((proj) => {
              const isSelected = proj.id === selectedProjectId;
              return (
                <button
                  key={proj.id}
                  onClick={() => setSelectedProjectId(proj.id)}
                  className={`w-full text-left rounded-xl p-3 transition border ${
                    isSelected
                      ? 'border-sky-500/50 bg-sky-950/20 text-white shadow-sm'
                      : 'border-zinc-800/40 bg-zinc-900/40 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-xs truncate">{proj.name}</span>
                    {proj.user_role && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.2 text-[9px] font-bold text-zinc-400 uppercase">
                        {proj.user_role}
                      </span>
                    )}
                  </div>
                  {proj.description && (
                    <p className="text-[11px] text-zinc-400 line-clamp-1">{proj.description}</p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right Column: Selected Project & RBAC Members */}
      <div className="flex-1 overflow-y-auto p-8 bg-zinc-950">
        {activeProject ? (
          <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-150">
            {/* Project Banner */}
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-xl font-bold text-zinc-100">{activeProject.name}</h1>
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-semibold text-sky-400">
                    Team: {activeTeam?.name}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 max-w-xl">
                  {activeProject.description || 'No description provided for this project.'}
                </p>
              </div>

              {activeProject.user_role && (
                <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs">
                  <Shield className="h-4 w-4 text-sky-400" />
                  <span className="text-zinc-400">Your Role:</span>
                  <span className="font-bold text-zinc-100 uppercase">{activeProject.user_role}</span>
                </div>
              )}
            </div>

            {/* Project Isolation Info Box */}
            <div className="flex items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-xs text-sky-300">
              <Info className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
              <div>
                <strong className="font-semibold text-sky-200">Strict Project Isolation:</strong>{' '}
                Team members only see and synchronize projects to which they are explicitly assigned below.
                Unassigned team members cannot view, pull, or modify endpoints in this project.
              </div>
            </div>

            {/* Project Members Section */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-zinc-100">Assigned Project Members</h3>
                  <p className="text-xs text-zinc-400">
                    Granular RBAC: Admin (full), Maintainer (manage envs &amp; collections), Contributor (read &amp; write OCC), Reader (read-only)
                  </p>
                </div>

                <button
                  onClick={() => setIsAssignMemberOpen(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-400 hover:bg-sky-500/20 transition shadow-sm"
                >
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>Assign Team Member</span>
                </button>
              </div>

              {/* Members Table */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-zinc-800 bg-zinc-950/80 text-zinc-400 uppercase text-[10px] font-semibold">
                    <tr>
                      <th className="px-4 py-3">Member</th>
                      <th className="px-4 py-3">Email</th>
                      <th className="px-4 py-3">Access Level (RBAC)</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-zinc-200">
                    {isLoadingMembers ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-zinc-500">
                          <Loader2 className="h-4 w-4 animate-spin inline mr-2 text-sky-400" />
                          Loading project members...
                        </td>
                      </tr>
                    ) : projectMembers.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-zinc-500">
                          No members assigned to this project yet. Assign team members to grant access.
                        </td>
                      </tr>
                    ) : (
                      projectMembers.map((member) => {
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
                                  : member.role === 'maintainer'
                                  ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                  : member.role === 'contributor'
                                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
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
                                  onClick={() => handleRemoveMember(member.user_id)}
                                  className="rounded p-1 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-400 transition"
                                  title="Unassign Member"
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
            Select a project from the list to view settings and manage member access.
          </div>
        )}
      </div>

      {/* Modal: Create Project */}
      {isCreateProjOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <FolderGit2 className="h-5 w-5 text-sky-400" />
                <span>Create New Project</span>
              </h3>
              <button
                onClick={() => setIsCreateProjOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Project Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Payment Gateway APIs"
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Description (Optional)</label>
                <textarea
                  placeholder="Project purpose and endpoint scopes"
                  rows={3}
                  value={newProjDesc}
                  onChange={(e) => setNewProjDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateProjOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingProj}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isCreatingProj ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Assign Team Member to Project */}
      {isAssignMemberOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <UserCheck className="h-5 w-5 text-sky-400" />
                <span>Assign Member to Project</span>
              </h3>
              <button
                onClick={() => setIsAssignMemberOpen(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleAssignMember} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Select Team Member</label>
                <select
                  required
                  value={selectedUserIdToAssign}
                  onChange={(e) => setSelectedUserIdToAssign(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                >
                  <option value="">-- Choose member from team --</option>
                  {teamMembers.map((tm) => {
                    const tmName = tm.user?.name || tm.name || 'Member';
                    const tmEmail = tm.user?.email || tm.email || '';
                    return (
                      <option key={tm.user_id} value={tm.user_id}>
                        {tmName} {tmEmail ? `(${tmEmail})` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Project Role (RBAC)</label>
                <select
                  value={assignedRole}
                  onChange={(e) => setAssignedRole(e.target.value as any)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                >
                  <option value="reader">Reader (Read-Only Collections)</option>
                  <option value="contributor">Contributor (Read &amp; Write Collections)</option>
                  <option value="maintainer">Maintainer (Collections &amp; Production Environments)</option>
                  <option value="admin">Admin (Manage Project &amp; Assign Members)</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAssignMemberOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedUserIdToAssign || isAssigningMember}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isAssigningMember ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm Assignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Modal: Edit Project Member Role */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Shield className="h-4 w-4 text-sky-400" />
                <span>Edit Project Role (RBAC)</span>
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
                  Project Role (RBAC)
                </label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as any)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                >
                  <option value="reader">Reader (Read-Only Collections)</option>
                  <option value="contributor">Contributor (Read &amp; Write Collections)</option>
                  <option value="maintainer">Maintainer (Collections &amp; Production Environments)</option>
                  <option value="admin">Admin (Manage Project &amp; Assign Members)</option>
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
    </div>
  );
};
