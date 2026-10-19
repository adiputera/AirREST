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
  Folder,
  Layers,
  ChevronDown,
  ChevronRight,
  Lock,
  FolderInput,
} from 'lucide-react';
import { useHubStore } from '../store/useHubStore';
import {
  apiListTeams,
  apiListTeamProjects,
  apiCreateProject,
  apiUpdateProject,
  apiDeleteProject,
  apiListProjectMembers,
  apiAddProjectMember,
  apiRemoveProjectMember,
  apiListTeamMembers,
  apiListProjectCollections,
  apiListProjectEnvironments,
  apiUpdateCollectionPermission,
  apiUpdateEnvironmentPermission,
  apiDeleteCollection,
  apiDeleteEnvironment,
  apiMoveCollection,
} from '../lib/api';
import {
  Team,
  Project,
  ProjectMember,
  TeamMember,
  Collection,
  Environment,
  ProjectRole,
  CollectionItem,
} from '../types';
import { ConfirmModal } from '../components/ConfirmModal';

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

  const [isEditProjOpen, setIsEditProjOpen] = useState(false);
  const [editProjName, setEditProjName] = useState('');
  const [editProjDesc, setEditProjDesc] = useState('');
  const [isUpdatingProj, setIsUpdatingProj] = useState(false);

  const [isAssignMemberOpen, setIsAssignMemberOpen] = useState(false);
  const [selectedUserIdToAssign, setSelectedUserIdToAssign] = useState<string>('');
  const [assignedRole, setAssignedRole] = useState<'admin' | 'maintainer' | 'contributor' | 'reader'>('contributor');
  const [isAssigningMember, setIsAssigningMember] = useState(false);

  const [editingMember, setEditingMember] = useState<ProjectMember | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'maintainer' | 'contributor' | 'reader'>('contributor');
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sub-tabs: 'members' | 'collections' | 'environments'
  const [projectSubTab, setProjectSubTab] = useState<'members' | 'collections' | 'environments'>('members');
  const [collections, setCollections] = useState<Collection[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [isLoadingEnvironments, setIsLoadingEnvironments] = useState(false);
  const [searchCollection, setSearchCollection] = useState('');
  const [searchEnvironment, setSearchEnvironment] = useState('');
  const [collapsedCollections, setCollapsedCollections] = useState<Record<string, boolean>>({});

  // Permission Modal
  const [permModalItem, setPermModalItem] = useState<{
    type: 'collection' | 'environment';
    id: string;
    name: string;
    currentRole: ProjectRole;
    version: number;
  } | null>(null);
  const [selectedPermRole, setSelectedPermRole] = useState<ProjectRole>('reader');
  const [isUpdatingPerm, setIsUpdatingPerm] = useState(false);

  // Move Collection Modal
  const [moveColItem, setMoveColItem] = useState<{ id: string; name: string } | null>(null);
  const [targetMoveProjectId, setTargetMoveProjectId] = useState<string>('');
  const [isMovingCol, setIsMovingCol] = useState(false);

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

  // 4. Load project collections and environments for selected project
  useEffect(() => {
    if (!selectedProjectId || !token) {
      setCollections([]);
      setEnvironments([]);
      return;
    }
    const loadResources = async () => {
      setIsLoadingCollections(true);
      setIsLoadingEnvironments(true);
      try {
        const [colData, envData] = await Promise.all([
          apiListProjectCollections(apiUrl, token, selectedProjectId, refreshToken || undefined),
          apiListProjectEnvironments(apiUrl, token, selectedProjectId, refreshToken || undefined),
        ]);
        setCollections(colData);
        setEnvironments(envData);
      } catch (err) {
        console.error('Failed to load project collections/environments:', err);
      } finally {
        setIsLoadingCollections(false);
        setIsLoadingEnvironments(false);
      }
    };
    loadResources();
  }, [selectedProjectId, token]);

  const activeProject = projects.find((p) => p.id === selectedProjectId);
  const activeTeam = teams.find((t) => t.id === selectedTeamId);
  const canEditProject =
    user?.role === 'superadmin' ||
    activeTeam?.user_role === 'admin' ||
    activeProject?.user_role === 'admin';
  const canManagePermissions = canEditProject || activeProject?.user_role === 'maintainer';
  const canMoveCollection =
    canEditProject ||
    activeProject?.user_role === 'maintainer' ||
    activeProject?.user_role === 'contributor';

  const eligibleTargetProjects = projects.filter((p) => {
    if (p.id === selectedProjectId) return false;
    const isSuper = user?.role === 'superadmin';
    const isTeamAdm = activeTeam?.user_role === 'admin';
    const role = p.user_role;
    return isSuper || isTeamAdm || role === 'admin' || role === 'maintainer' || role === 'contributor';
  });

  const handleConfirmMoveCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !moveColItem || !targetMoveProjectId) return;
    setIsMovingCol(true);
    setErrorMsg(null);
    try {
      await apiMoveCollection(apiUrl, token, moveColItem.id, targetMoveProjectId, undefined, refreshToken || undefined);
      setMoveColItem(null);
      if (selectedProjectId) {
        const data = await apiListProjectCollections(apiUrl, token, selectedProjectId, refreshToken || undefined);
        setCollections(data);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to move collection');
    } finally {
      setIsMovingCol(false);
    }
  };

  // Handle Open Permission Modal
  const handleOpenPermModal = (
    type: 'collection' | 'environment',
    id: string,
    name: string,
    currentRole: ProjectRole = 'reader',
    version: number = 1
  ) => {
    setPermModalItem({ type, id, name, currentRole, version });
    setSelectedPermRole(currentRole);
    setErrorMsg(null);
  };

  // Handle Save Permission
  const handleSavePermission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !permModalItem) return;
    setIsUpdatingPerm(true);
    setErrorMsg(null);
    try {
      if (permModalItem.type === 'collection') {
        const updated = await apiUpdateCollectionPermission(
          apiUrl,
          token,
          permModalItem.id,
          selectedPermRole,
          permModalItem.version,
          refreshToken || undefined
        );
        setCollections((prev) =>
          prev.map((c) =>
            c.id === permModalItem.id
              ? { ...c, min_role: selectedPermRole, version: updated.version || c.version + 1 }
              : c
          )
        );
      } else {
        const updated = await apiUpdateEnvironmentPermission(
          apiUrl,
          token,
          permModalItem.id,
          selectedPermRole,
          permModalItem.version,
          refreshToken || undefined
        );
        setEnvironments((prev) =>
          prev.map((env) =>
            env.id === permModalItem.id
              ? { ...env, min_role: selectedPermRole, version: updated.version || env.version + 1 }
              : env
          )
        );
      }
      setPermModalItem(null);
    } catch (err: any) {
      alert(err.message || 'Failed to update permission');
    } finally {
      setIsUpdatingPerm(false);
    }
  };

  const toggleCollectionCollapse = (colId: string) => {
    setCollapsedCollections((prev) => ({
      ...prev,
      [colId]: !prev[colId],
    }));
  };

  const getMethodBadgeClass = (method: string) => {
    switch (method.toUpperCase()) {
      case 'GET':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'POST':
        return 'bg-sky-500/10 text-sky-400 border border-sky-500/20';
      case 'PUT':
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
      case 'DELETE':
        return 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
      case 'PATCH':
        return 'bg-purple-500/10 text-purple-400 border border-purple-500/20';
      default:
        return 'bg-zinc-800 text-zinc-300 border border-zinc-700';
    }
  };

  const getMinRoleBadge = (role: ProjectRole = 'reader') => {
    switch (role) {
      case 'admin':
        return {
          label: 'Admin Only',
          badgeClass: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
        };
      case 'maintainer':
        return {
          label: 'Maintainer+',
          badgeClass: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
        };
      case 'contributor':
        return {
          label: 'Contributor+',
          badgeClass: 'bg-sky-500/10 text-sky-400 border border-sky-500/20',
        };
      case 'reader':
      default:
        return {
          label: 'Reader (All)',
          badgeClass: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
        };
    }
  };

  const renderCollectionItems = (items: CollectionItem[] = []) => {
    if (!items || items.length === 0) {
      return (
        <div className="py-6 text-center text-xs text-zinc-500">
          No requests in this collection yet.
        </div>
      );
    }

    const rootItems = items.filter((i) => !i.parent_id);
    const childMap = new Map<string, CollectionItem[]>();
    for (const item of items) {
      if (item.parent_id) {
        const list = childMap.get(item.parent_id) || [];
        list.push(item);
        childMap.set(item.parent_id, list);
      }
    }

    const renderItem = (item: CollectionItem, depth = 0) => {
      const isFolder = item.type === 'folder';
      const children = childMap.get(item.id) || [];

      if (isFolder) {
        return (
          <div key={item.id} className="space-y-1">
            <div
              className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-zinc-950/40 text-xs font-semibold text-zinc-300 border border-zinc-800/60"
              style={{ marginLeft: `${depth * 16}px` }}
            >
              <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="truncate">{item.name}</span>
              <span className="text-[10px] text-zinc-500 font-normal">
                ({children.length} {children.length === 1 ? 'item' : 'items'})
              </span>
            </div>
            {children.length > 0 && (
              <div className="space-y-1">
                {children.map((child) => renderItem(child, depth + 1))}
              </div>
            )}
          </div>
        );
      }

      // It is a request item - purely list title, cannot click like in extension
      const method = (item.method || 'GET').toUpperCase();
      return (
        <div
          key={item.id}
          className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-zinc-900/60 border border-zinc-800/40 text-xs cursor-default select-none transition"
          style={{ marginLeft: `${depth * 16}px` }}
          title={item.name}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase shrink-0 ${getMethodBadgeClass(
                method
              )}`}
            >
              {method}
            </span>
            <span className="font-medium text-zinc-200 truncate">{item.name}</span>
          </div>
          {item.url && (
            <span className="text-[10px] text-zinc-500 font-mono truncate max-w-xs ml-2 hidden sm:inline">
              {item.url}
            </span>
          )}
        </div>
      );
    };

    return (
      <div className="p-3 space-y-1 bg-zinc-950/60 border-t border-zinc-800/80">
        {rootItems.length > 0
          ? rootItems.map((item) => renderItem(item, 0))
          : items.map((item) => renderItem(item, 0))}
      </div>
    );
  };

  // Handle Open Edit Project
  const handleOpenEditProject = (proj: Project) => {
    setEditProjName(proj.name);
    setEditProjDesc(proj.description || '');
    setErrorMsg(null);
    setIsEditProjOpen(true);
  };

  // Handle Update Project
  const handleUpdateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !selectedProjectId) return;
    setIsUpdatingProj(true);
    setErrorMsg(null);
    try {
      const updated = await apiUpdateProject(
        apiUrl,
        token,
        selectedProjectId,
        editProjName.trim(),
        editProjDesc.trim(),
        refreshToken || undefined
      );
      setProjects(projects.map((p) => (p.id === selectedProjectId ? { ...p, ...updated } : p)));
      setIsEditProjOpen(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update project');
    } finally {
      setIsUpdatingProj(false);
    }
  };

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

  // State for Confirmations
  const [memberToRemove, setMemberToRemove] = useState<ProjectMember | null>(null);
  const [isRemovingMember, setIsRemovingMember] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<Collection | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [environmentToDelete, setEnvironmentToDelete] = useState<Environment | null>(null);
  const [isDeletingEnvironment, setIsDeletingEnvironment] = useState(false);

  // Handle Remove Member Confirmation
  const confirmRemoveMember = async () => {
    if (!token || !selectedProjectId || !memberToRemove) return;
    setIsRemovingMember(true);
    try {
      await apiRemoveProjectMember(apiUrl, token, selectedProjectId, memberToRemove.user_id, refreshToken || undefined);
      setProjectMembers(projectMembers.filter((m) => m.user_id !== memberToRemove.user_id));
      setMemberToRemove(null);
    } catch (err: any) {
      alert(err.message || 'Failed to unassign member');
    } finally {
      setIsRemovingMember(false);
    }
  };

  // Handle Delete Project Confirmation
  const confirmDeleteProject = async () => {
    if (!token || !projectToDelete) return;
    setIsDeletingProject(true);
    try {
      await apiDeleteProject(apiUrl, token, projectToDelete.id, refreshToken || undefined);
      const updatedProjects = projects.filter((p) => p.id !== projectToDelete.id);
      setProjects(updatedProjects);
      if (selectedProjectId === projectToDelete.id) {
        setSelectedProjectId(updatedProjects[0]?.id || null);
      }
      setProjectToDelete(null);
    } catch (err: any) {
      alert(err.message || 'Failed to delete project');
    } finally {
      setIsDeletingProject(false);
    }
  };

  // Handle Delete Collection Confirmation
  const confirmDeleteCollection = async () => {
    if (!token || !collectionToDelete) return;
    setIsDeletingCollection(true);
    try {
      await apiDeleteCollection(apiUrl, token, collectionToDelete.id, refreshToken || undefined);
      setCollections((prev) => prev.filter((c) => c.id !== collectionToDelete.id));
      setCollectionToDelete(null);
    } catch (err: any) {
      alert(err.message || 'Failed to delete collection');
    } finally {
      setIsDeletingCollection(false);
    }
  };

  // Handle Delete Environment Confirmation
  const confirmDeleteEnvironment = async () => {
    if (!token || !environmentToDelete) return;
    setIsDeletingEnvironment(true);
    try {
      await apiDeleteEnvironment(apiUrl, token, environmentToDelete.id, refreshToken || undefined);
      setEnvironments((prev) => prev.filter((e) => e.id !== environmentToDelete.id));
      setEnvironmentToDelete(null);
    } catch (err: any) {
      alert(err.message || 'Failed to delete environment');
    } finally {
      setIsDeletingEnvironment(false);
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

  const filteredCollections = collections.filter((c) => {
    const q = searchCollection.toLowerCase();
    if (!q) return true;
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.description?.toLowerCase().includes(q)) return true;
    return (c.items || []).some((item) => item.name.toLowerCase().includes(q));
  });

  const filteredEnvironments = environments.filter((env) => {
    const q = searchEnvironment.toLowerCase();
    if (!q) return true;
    if (env.name.toLowerCase().includes(q)) return true;
    const rawVars: any[] = Array.isArray(env.variables)
      ? env.variables
      : typeof env.variables === 'string'
      ? JSON.parse(env.variables || '[]')
      : [];
    return rawVars.some(
      (v: any) =>
        (typeof v.key === 'string' && v.key.toLowerCase().includes(q)) ||
        (typeof v.value === 'string' && v.value.toLowerCase().includes(q))
    );
  });

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
                  {canEditProject && (
                    <button
                      onClick={() => handleOpenEditProject(activeProject)}
                      className="rounded-lg p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
                      title="Edit Project"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-xs text-zinc-400 max-w-xl">
                  {activeProject.description || 'No description provided for this project.'}
                </p>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                {canEditProject && (
                  <>
                    <button
                      onClick={() => handleOpenEditProject(activeProject)}
                      className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800/80 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 hover:text-white transition shadow-sm"
                    >
                      <Pencil className="h-3.5 w-3.5 text-zinc-400" />
                      <span>Edit Project</span>
                    </button>
                    <button
                      onClick={() => setProjectToDelete(activeProject)}
                      className="flex items-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 transition shadow-sm"
                      title="Delete Project"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete Project</span>
                    </button>
                  </>
                )}
                {activeProject.user_role && (
                  <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs">
                    <Shield className="h-4 w-4 text-sky-400" />
                    <span className="text-zinc-400">Your Role:</span>
                    <span className="font-bold text-zinc-100 uppercase">{activeProject.user_role}</span>
                  </div>
                )}
              </div>
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

            {/* Project Sub-Navigation Tabs */}
            <div className="flex items-center gap-1.5 border-b border-zinc-800 pb-3">
              <button
                type="button"
                onClick={() => setProjectSubTab('members')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
                  projectSubTab === 'members'
                    ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                <Users className="h-3.5 w-3.5 text-indigo-400" />
                <span>Members</span>
                <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] font-bold text-zinc-300">
                  {projectMembers.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setProjectSubTab('collections')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
                  projectSubTab === 'collections'
                    ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                <Folder className="h-3.5 w-3.5 text-amber-400" />
                <span>Collections</span>
                <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] font-bold text-zinc-300">
                  {collections.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setProjectSubTab('environments')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition ${
                  projectSubTab === 'environments'
                    ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                }`}
              >
                <Layers className="h-3.5 w-3.5 text-emerald-400" />
                <span>Environments</span>
                <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] font-bold text-zinc-300">
                  {environments.length}
                </span>
              </button>
            </div>

            {/* TAB 1: Assigned Project Members */}
            {projectSubTab === 'members' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
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
                                      onClick={() => setMemberToRemove(member)}
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
            )}

            {/* TAB 2: Project Collections */}
            {projectSubTab === 'collections' && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                      <Folder className="h-4 w-4 text-amber-400" />
                      <span>Project Collections ({filteredCollections.length})</span>
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Listing all request titles. Detail editing is handled in the AirREST Extension.
                    </p>
                  </div>

                  <div className="relative w-full sm:w-64">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Filter collections or requests..."
                      value={searchCollection}
                      onChange={(e) => setSearchCollection(e.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>

                {isLoadingCollections ? (
                  <div className="py-12 text-center text-xs text-zinc-500">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2 text-sky-400" />
                    Loading project collections...
                  </div>
                ) : filteredCollections.length === 0 ? (
                  <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-10 text-center text-xs text-zinc-500">
                    <Folder className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
                    <div className="font-semibold text-zinc-400 mb-1">No collections found</div>
                    <p className="max-w-xs mx-auto text-zinc-500">
                      No collections match your criteria. Create or sync collections from the AirREST extension.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredCollections.map((col) => {
                      const isCollapsed = !!collapsedCollections[col.id];
                      const minRole = col.min_role || 'reader';
                      const roleBadge = getMinRoleBadge(minRole);
                      const reqCount = (col.items || []).filter((i) => i.type === 'request').length;

                      return (
                        <div
                          key={col.id}
                          className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm transition hover:border-zinc-700/80"
                        >
                          <div className="p-4 flex items-center justify-between gap-3 bg-zinc-950/60">
                            <button
                              type="button"
                              onClick={() => toggleCollectionCollapse(col.id)}
                              className="flex items-center gap-3 text-left min-w-0 flex-1 group"
                            >
                              <div className="text-zinc-500 group-hover:text-zinc-300 transition">
                                {isCollapsed ? (
                                  <ChevronRight className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </div>
                              <Folder className="h-4 w-4 text-amber-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-xs text-zinc-100 group-hover:text-sky-300 transition truncate">
                                    {col.name}
                                  </span>
                                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 font-semibold">
                                    {reqCount} {reqCount === 1 ? 'request' : 'requests'}
                                  </span>
                                </div>
                                {col.description && (
                                  <p className="text-[11px] text-zinc-400 line-clamp-1 mt-0.5">
                                    {col.description}
                                  </p>
                                )}
                              </div>
                            </button>

                            <div className="flex items-center gap-2 shrink-0">
                              <span
                                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${roleBadge.badgeClass}`}
                                title={`Minimum role required: ${minRole}`}
                              >
                                {roleBadge.label}
                              </span>

                              {canManagePermissions && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleOpenPermModal('collection', col.id, col.name, minRole, col.version)
                                    }
                                    className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
                                    title="Change Collection Permission"
                                  >
                                    <Shield className="h-3 w-3 text-sky-400" />
                                    <span>Permission</span>
                                  </button>
                                  {canMoveCollection && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMoveColItem({ id: col.id, name: col.name });
                                        setTargetMoveProjectId(eligibleTargetProjects[0]?.id || '');
                                        setErrorMsg(null);
                                      }}
                                      className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
                                      title="Move Collection to Another Project"
                                    >
                                      <FolderInput className="h-3 w-3 text-amber-400" />
                                      <span>Move</span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setCollectionToDelete(col)}
                                    className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-red-500/20 transition"
                                    title="Delete Collection"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                    <span>Delete</span>
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {!isCollapsed && renderCollectionItems(col.items || [])}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: Project Environments */}
            {projectSubTab === 'environments' && (
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                      <Layers className="h-4 w-4 text-emerald-400" />
                      <span>Project Environments ({filteredEnvironments.length})</span>
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Showing synchronized environment variables. Access is protected by minimum role.
                    </p>
                  </div>

                  <div className="relative w-full sm:w-64">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Filter environments or variables..."
                      value={searchEnvironment}
                      onChange={(e) => setSearchEnvironment(e.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                </div>

                {isLoadingEnvironments ? (
                  <div className="py-12 text-center text-xs text-zinc-500">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2 text-sky-400" />
                    Loading project environments...
                  </div>
                ) : filteredEnvironments.length === 0 ? (
                  <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-10 text-center text-xs text-zinc-500">
                    <Layers className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
                    <div className="font-semibold text-zinc-400 mb-1">No environments found</div>
                    <p className="max-w-xs mx-auto text-zinc-500">
                      No environments match your criteria. Create or sync environments from the AirREST extension.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredEnvironments.map((env) => {
                      const minRole = env.min_role || 'reader';
                      const roleBadge = getMinRoleBadge(minRole);
                      const rawVars: any[] = Array.isArray(env.variables)
                        ? env.variables
                        : typeof env.variables === 'string'
                        ? JSON.parse(env.variables || '[]')
                        : [];

                      return (
                        <div
                          key={env.id}
                          className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm"
                        >
                          <div className="p-4 flex items-center justify-between gap-3 bg-zinc-950/60">
                            <div className="flex items-center gap-3">
                              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                                <Layers className="h-4 w-4" />
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-xs text-zinc-100">{env.name}</span>
                                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 font-semibold">
                                    {rawVars.length} {rawVars.length === 1 ? 'variable' : 'variables'}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span
                                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${roleBadge.badgeClass}`}
                                title={`Minimum role required: ${minRole}`}
                              >
                                {roleBadge.label}
                              </span>

                              {canManagePermissions && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleOpenPermModal('environment', env.id, env.name, minRole, env.version)
                                    }
                                    className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-semibold text-zinc-300 hover:text-white hover:bg-zinc-700 transition"
                                    title="Change Environment Permission"
                                  >
                                    <Shield className="h-3 w-3 text-sky-400" />
                                    <span>Permission</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEnvironmentToDelete(env)}
                                    className="flex items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-400 hover:text-red-300 hover:bg-red-500/20 transition"
                                    title="Delete Environment"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                    <span>Delete</span>
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Variables Table */}
                          <div className="overflow-x-auto border-t border-zinc-800/80">
                            <table className="w-full text-left text-xs">
                              <thead className="border-b border-zinc-800 bg-zinc-950 text-zinc-400 uppercase text-[10px] font-semibold">
                                <tr>
                                  <th className="px-4 py-2.5 w-1/3">Variable Key</th>
                                  <th className="px-4 py-2.5 w-1/2">Value</th>
                                  <th className="px-4 py-2.5 text-right">Status</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-800/40 text-zinc-200">
                                {rawVars.length === 0 ? (
                                  <tr>
                                    <td colSpan={3} className="py-6 text-center text-xs text-zinc-500">
                                      No variables configured in this environment.
                                    </td>
                                  </tr>
                                ) : (
                                  rawVars.map((v: any, idx: number) => {
                                    const isEnabled = v.enabled !== false;
                                    return (
                                      <tr key={v.id || v.key || idx} className="hover:bg-zinc-800/20 transition">
                                        <td className="px-4 py-2.5 font-mono text-xs text-zinc-200 font-semibold">
                                          {v.key || <span className="text-zinc-500 italic">unnamed</span>}
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-xs text-zinc-300">
                                          <span className="rounded bg-zinc-950/80 px-2 py-1 text-[11px] border border-zinc-800 inline-block max-w-md truncate">
                                            {v.value !== undefined && v.value !== null ? String(v.value) : ''}
                                          </span>
                                        </td>
                                        <td className="px-4 py-2.5 text-right">
                                          <span
                                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                              isEnabled
                                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                : 'bg-zinc-800 text-zinc-400 border border-zinc-700/50'
                                            }`}
                                          >
                                            <span
                                              className={`h-1.5 w-1.5 rounded-full ${
                                                isEnabled ? 'bg-emerald-400' : 'bg-zinc-500'
                                              }`}
                                            />
                                            <span>{isEnabled ? 'Active' : 'Disabled'}</span>
                                          </span>
                                        </td>
                                      </tr>
                                    );
                                  })
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
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
      {/* Modal: Edit Project */}
      {isEditProjOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Pencil className="h-5 w-5 text-sky-400" />
                <span>Edit Project</span>
              </h3>
              <button
                onClick={() => setIsEditProjOpen(false)}
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

            <form onSubmit={handleUpdateProject} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Project Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Payments Microservice"
                  value={editProjName}
                  onChange={(e) => setEditProjName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Description (Optional)</label>
                <textarea
                  placeholder="Project scope or documentation details"
                  rows={3}
                  value={editProjDesc}
                  onChange={(e) => setEditProjDesc(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsEditProjOpen(false)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingProj || !editProjName.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isUpdatingProj ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Unassigning Member */}
      <ConfirmModal
        isOpen={!!memberToRemove}
        onClose={() => setMemberToRemove(null)}
        onConfirm={confirmRemoveMember}
        isLoading={isRemovingMember}
        title="Unassign Project Member"
        message={
          <span>
            Are you sure you want to unassign{' '}
            <strong className="text-zinc-200">
              {memberToRemove?.name || memberToRemove?.email || 'this member'}
            </strong>{' '}
            from the project? They will no longer have access to this project's collections and environments.
          </span>
        }
        confirmText="Unassign Member"
        variant="danger"
      />

      {/* Confirmation Modal for Deleting Project */}
      <ConfirmModal
        isOpen={!!projectToDelete}
        onClose={() => setProjectToDelete(null)}
        onConfirm={confirmDeleteProject}
        isLoading={isDeletingProject}
        title="Delete Project"
        message={
          <span>
            Are you sure you want to delete project{' '}
            <strong className="text-zinc-200">"{projectToDelete?.name}"</strong>? This action cannot be undone and will permanently delete all collections and environments inside it.
          </span>
        }
        confirmText="Delete Project"
        variant="danger"
      />

      {/* Confirmation Modal for Deleting Collection */}
      <ConfirmModal
        isOpen={!!collectionToDelete}
        onClose={() => setCollectionToDelete(null)}
        onConfirm={confirmDeleteCollection}
        isLoading={isDeletingCollection}
        title="Delete Collection"
        message={
          <span>
            Are you sure you want to delete collection{' '}
            <strong className="text-zinc-200">"{collectionToDelete?.name}"</strong>? This will permanently remove the collection and all its requests.
          </span>
        }
        confirmText="Delete Collection"
        variant="danger"
      />

      {/* Confirmation Modal for Deleting Environment */}
      <ConfirmModal
        isOpen={!!environmentToDelete}
        onClose={() => setEnvironmentToDelete(null)}
        onConfirm={confirmDeleteEnvironment}
        isLoading={isDeletingEnvironment}
        title="Delete Environment"
        message={
          <span>
            Are you sure you want to delete environment{' '}
            <strong className="text-zinc-200">"{environmentToDelete?.name}"</strong>? All variables defined in this environment will be permanently removed.
          </span>
        }
        confirmText="Delete Environment"
        variant="danger"
      />

      {/* Modal: Change Permission for Collection or Environment */}
      {permModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                <Shield className="h-5 w-5 text-sky-400" />
                <span>
                  Change {permModalItem.type === 'collection' ? 'Collection' : 'Environment'} Permission
                </span>
              </h3>
              <button
                type="button"
                onClick={() => setPermModalItem(null)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-4">
              Configure the minimum project role required to view and sync{' '}
              <strong className="text-zinc-200">"{permModalItem.name}"</strong>.
            </p>

            <form onSubmit={handleSavePermission} className="space-y-4">
              <div className="space-y-2">
                {[
                  {
                    role: 'reader' as ProjectRole,
                    title: 'Reader (All Assigned Members)',
                    desc: 'Accessible to all members assigned to this project.',
                    badgeClass: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
                  },
                  {
                    role: 'contributor' as ProjectRole,
                    title: 'Contributor+',
                    desc: 'Restricted to Contributors, Maintainers, and Admins.',
                    badgeClass: 'bg-sky-500/10 text-sky-400 border border-sky-500/20',
                  },
                  {
                    role: 'maintainer' as ProjectRole,
                    title: 'Maintainer+',
                    desc: 'Restricted to Maintainers and Admins.',
                    badgeClass: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                  },
                  {
                    role: 'admin' as ProjectRole,
                    title: 'Admin Only',
                    desc: 'Restricted strictly to Project Admins and Superadmins.',
                    badgeClass: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
                    disabled: !canEditProject,
                  },
                ].map((opt) => {
                  const isSelected = selectedPermRole === opt.role;
                  return (
                    <label
                      key={opt.role}
                      onClick={() => {
                        if (!opt.disabled) setSelectedPermRole(opt.role);
                      }}
                      className={`flex items-start gap-3 p-3 rounded-xl border transition ${
                        opt.disabled
                          ? 'opacity-40 cursor-not-allowed border-zinc-900 bg-zinc-950'
                          : isSelected
                          ? 'border-sky-500/60 bg-sky-950/20 shadow-sm cursor-pointer'
                          : 'border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 hover:border-zinc-700 cursor-pointer'
                      }`}
                    >
                      <input
                        type="radio"
                        name="permMinRole"
                        value={opt.role}
                        disabled={opt.disabled}
                        checked={isSelected}
                        onChange={() => setSelectedPermRole(opt.role)}
                        className="mt-0.5 text-sky-500 focus:ring-sky-500"
                      />
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs font-semibold text-zinc-200">{opt.title}</span>
                          <span className={`rounded px-1.5 py-0.2 text-[9px] font-bold uppercase ${opt.badgeClass}`}>
                            {opt.role}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400">{opt.desc}</p>
                        {opt.disabled && (
                          <p className="text-[10px] text-amber-400/80 mt-1">Requires Project Admin role</p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPermModalItem(null)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUpdatingPerm}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isUpdatingPerm ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save Permission'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Move Collection Modal */}
      {moveColItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80 mb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-400">
                  <FolderInput className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-zinc-100">Move Collection</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Relocate <span className="font-semibold text-zinc-200">"{moveColItem.name}"</span> to another project.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMoveColItem(null)}
                className="rounded-lg p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 transition"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {errorMsg && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleConfirmMoveCollection} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                  Destination Project (Same Team: {activeTeam?.name})
                </label>
                {eligibleTargetProjects.length === 0 ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-center">
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      No other eligible projects found in this team. You must have at least Contributor role in the destination project.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select
                      value={targetMoveProjectId}
                      onChange={(e) => setTargetMoveProjectId(e.target.value)}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-900 p-2.5 text-xs text-zinc-200 focus:border-sky-500 focus:outline-none cursor-pointer"
                    >
                      {eligibleTargetProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.user_role ? `(${p.user_role.toUpperCase()})` : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-zinc-500">
                      Collection and all requests will be relocated to the selected project.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => setMoveColItem(null)}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isMovingCol || eligibleTargetProjects.length === 0 || !targetMoveProjectId}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 transition shadow-md disabled:opacity-50"
                >
                  {isMovingCol ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Move Collection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
